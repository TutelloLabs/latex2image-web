const fs = require("fs");
const fsPromises = fs.promises;
const shell = require("shelljs");
const express = require("express");
const https = require("https");
const promiseRouter = require("express-promise-router");
const queue = require("express-queue");
const sharp = require("sharp");
const Promise = require("bluebird");
const AWS = require("aws-sdk");
require("dotenv").config();

const port = 80;

const tempDir = "temp";
const outputDir = "output";

// Checklist of valid formats from the frontend, to verify form values are correct
const validFormats = ["SVG", "PNG", "JPG"];

// Maps scales received from the frontend into values appropriate for LaTeX
const scaleMap = {
	"10%": "0.1",
	"25%": "0.25",
	"50%": "0.5",
	"75%": "0.75",
	"100%": "1.0",
	"125%": "1.25",
	"150%": "1.5",
	"200%": "2.0",
	"500%": "5.0",
	"1000%": "10.0",
};

// Unsupported commands we will error on
const unsupportedCommands = [
	"\\usepackage",
	"\\input",
	"\\include",
	"\\write18",
	"\\immediate",
	"\\verbatiminput",
];

const app = express();

const options = {
	key: fs.readFileSync("fullchain.pem"),
	cert: fs.readFileSync("privkey.pem"),
};

const bodyParser = require("body-parser");
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Allow static html files and output files to be accessible
// app.use("/", express.static(staticDir));
// app.use("/output", express.static(outputDir));

const conversionRouter = promiseRouter();
app.use(conversionRouter);

// Queue requests to ensure that only one is processed at a time, preventing
// multiple concurrent Docker containers from exhausting system resources
conversionRouter.use(queue({ activeLimit: 1, queuedLimit: -1 }));

// Configure AWS SDK for DigitalOcean Spaces
const s3 = new AWS.S3({
	forcePathStyle: false,
	endpoint: "https://lon1.digitaloceanspaces.com",
	region: "us-east-1",
	credentials: {
		accessKeyId: process.env.DO_SPACES_KEY,
		secretAccessKey: process.env.DO_SPACES_SECRET,
	},
});

// Conversion request endpoint
conversionRouter.post("/convert", async (req, res) => {
	const id = generateID(); // Generate a unique ID for this request

	try {
		if (!req.body.apiKey || req.body.apiKey !== process.env.API_KEY) {
			res.end(JSON.stringify({ error: "Invalid API key." }));
			return;
		}

		// some unique uuid

		if (!req.body.latexInput) {
			res.end(JSON.stringify({ error: "No LaTeX input provided." }));
			return;
		}

		if (!scaleMap[req.body.outputScale]) {
			res.end(JSON.stringify({ error: "Invalid scale." }));
			return;
		}

		if (!validFormats.includes(req.body.outputFormat)) {
			res.end(JSON.stringify({ error: "Invalid image format." }));
			return;
		}

		const unsupportedCommandsPresent = unsupportedCommands.filter((cmd) =>
			req.body.latexInput.includes(cmd),
		);
		if (unsupportedCommandsPresent.length > 0) {
			res.end(
				JSON.stringify({
					error: `Unsupported command(s) found: ${unsupportedCommandsPresent.join(
						", ",
					)}. Please remove them and try again.`,
				}),
			);
			return;
		}

		const equation = req.body.latexInput.trim();
		const fileFormat = req.body.outputFormat.toLowerCase();
		const outputScale = scaleMap[req.body.outputScale];

		// Generate and write the .tex file
		await fsPromises.mkdir(`${tempDir}/${id}`);
		await fsPromises.writeFile(
			`${tempDir}/${id}/equation.tex`,
			getLatexTemplate(equation),
		);

		// Run the LaTeX compiler and generate a .svg file
		await execAsync(getDockerCommand(id, outputScale));

		const inputSvgFileName = `${tempDir}/${id}/equation.svg`;
		const outputFileName = `${tempDir}/${id}/img-${id}.${fileFormat}`;

		// Return the SVG image, no further processing required
		if (fileFormat === "svg") {
			await fsPromises.copyFile(inputSvgFileName, outputFileName);

			// Convert to PNG
		} else if (fileFormat === "png") {
			await sharp(inputSvgFileName, { density: 96 }).toFile(outputFileName); // Sharp's PNG type is implicitly determined via the output file extension

			// Convert to JPG
		} else {
			await sharp(inputSvgFileName, { density: 96 })
				.flatten({ background: { r: 255, g: 255, b: 255 } }) // as JPG is not transparent, use a white background
				.jpeg({ quality: 95 })
				.toFile(outputFileName);
		}

		// Upload the file to DigitalOcean Space
		const fileContent = await fsPromises.readFile(outputFileName);
		console.log("bucket name", process.env.DO_SPACES_BUCKET);
		const params = {
			Bucket: process.env.DO_SPACES_BUCKET,
			Key: `img-${id}.${fileFormat}`,
			Body: fileContent,
			ACL: "public-read",
			ContentType: `image/${fileFormat}`,
		};

		const uploadResult = await s3.upload(params).promise();
		const imageURL = uploadResult.Location.replace(".lon1", ".lon1.cdn");
		await fsPromises.unlink(outputFileName);

		await cleanupTempFilesAsync(id);
		res.end(JSON.stringify({ imageURL }));

		// An exception occurred somewhere, return an error
	} catch (e) {
		console.error(e);
		await cleanupTempFilesAsync(id);
		res.end(
			JSON.stringify({
				error:
					"Error converting LaTeX to image. Please ensure the input is valid.",
			}),
		);
	}
});

// Create temp and output directories if they don't exist yet
if (!fs.existsSync(tempDir)) {
	fs.mkdirSync(tempDir);
}
if (!fs.existsSync(outputDir)) {
	fs.mkdirSync(outputDir);
}

// Start the server
// app.listen(port, () =>
// 	console.log(`Latex2Image listening at http://localhost:${port}`),
// );
https.createServer(options, app).listen(443, () => {
	console.log("HTTPS Server running with self-signed certificate");
});

//// Helper functions

// Get the LaTeX document template for the requested equation
function getLatexTemplate(equation) {
	return `
	\\documentclass[12pt]{article}
	\\usepackage{amsmath}
	\\usepackage{amssymb}
	\\usepackage{amsfonts}
	\\usepackage{xcolor}
	\\usepackage{siunitx}
	\\usepackage[utf8]{inputenc}
	\\thispagestyle{empty}
	\\begin{document}
	${equation}
	\\end{document}`;
}

// Get the final command responsible for launching the Docker container and generating a svg file
function getDockerCommand(id, output_scale) {
	// Commands to run within the container
	const containerCmds = `
	# Prevent LaTeX from reading/writing files in parent directories
	echo 'openout_any = p\nopenin_any = p' > /tmp/texmf.cnf
	export TEXMFCNF='/tmp:'

	# Compile .tex file to .dvi file. Timeout kills it after 5 seconds if held up
	timeout 5 latex -no-shell-escape -interaction=nonstopmode -halt-on-error equation.tex

	# Convert .dvi to .svg file. Timeout kills it after 5 seconds if held up
	timeout 5 dvisvgm --no-fonts --scale=${output_scale} --exact equation.dvi`;

	// Start the container in the appropriate directory and run commands within it.
	// Files in this directory will be accessible under /data within the container.
	return `
	cd ${tempDir}/${id}
	docker run --rm -i --user="$(id -u):$(id -g)" \
		--net=none -v "$PWD":/data "blang/latex:ubuntu" \
		/bin/bash -c "${containerCmds}"`;
}

// Deletes temporary files created during a conversion request
function cleanupTempFilesAsync(id) {
	return fsPromises.rmdir(`${tempDir}/${id}`, { recursive: true });
}

// Execute a shell command
function execAsync(cmd, opts = {}) {
	return new Promise((resolve, reject) => {
		shell.exec(cmd, opts, (code, stdout, stderr) => {
			if (code != 0) reject(new Error(stderr));
			else resolve(stdout);
		});
	});
}

function generateID() {
	// Generate a random 16-char hexadecimal ID
	let output = "";
	for (let i = 0; i < 16; i++) {
		output += "0123456789abcdef".charAt(Math.floor(Math.random() * 16));
	}
	return output;
}
