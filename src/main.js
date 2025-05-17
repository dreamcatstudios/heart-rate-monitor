"use strict";

const heartRateMonitor = (function () {
	// Size of sampling image
	const IMAGE_WIDTH = 30;
	const IMAGE_HEIGHT = 30;

	// Array of measured samples
	const SAMPLE_BUFFER = [];

	// Max 5 seconds of samples (at 60 samples per second)
	const MAX_SAMPLES = 60 * 5;

	// How long to wait in milliseconds for the camera image to stabilize before starting measurement
	const START_DELAY = 1500;

	// Callback for reporting the measured heart rate
	let ON_BPM_CHANGE;

	// The <video> element for streaming the camera feed into
	let VIDEO_ELEMENT;

	// Canvas element for sampling image data from the video stream
	let SAMPLING_CANVAS;
	let SAMPLING_CONTEXT;

	// Canvas element for the graph
	let GRAPH_CANVAS;
	let GRAPH_CONTEXT;

	// Graph properties
	let GRAPH_COLOR;
	let GRAPH_WIDTH;

	// Whether to print debug messages
	let DEBUG = false;

	// Video stream object
	let VIDEO_STREAM;
	let MONITORING = false;

	// --- Parameters for BPM Stabilization Algorithm ---
	const RAW_BPM_BUFFER_SIZE = 10;         // Number of raw BPMs to consider for median
	const REQUIRED_STABILITY_COUNT = 5;     // How many consecutive medians must be stable to lock BPM
	const BPM_STABILITY_TOLERANCE = 3;      // Max difference (in BPM) for a median to be considered stable with the current candidate
	const MIN_SAMPLES_FOR_RELIABLE_BPM = MAX_SAMPLES / 3; // Require buffer to be 1/3 full (approx 1.6s at 60fps sampling rate)
	const MIN_CROSSINGS_FOR_CALCULATION = 4;// Minimum crossings to calculate a raw BPM (needs at least 3 intervals)
	const MIN_SIGNAL_RANGE_FOR_CALCULATION = 0.001; // Minimum signal peak-to-peak amplitude

	// Variables for BPM stabilization state
	let rawBpmBuffer = [];
	let stableBpmCandidate = null;
	let stabilityCounter = 0;
	let lastDisplayedBpm = null; // The "locked" BPM value shown to the user
	// --- End of BPM Stabilization Parameters & State ---


	// Debug logging
	const log = (...args) => {
		if (DEBUG) {
			console.log(...args);
			const debugLogEl = document.querySelector("#debug-log");
			if (debugLogEl) {
				debugLogEl.innerHTML += args.join(" ") + "<br />";
				debugLogEl.scrollTop = debugLogEl.scrollHeight; // Auto-scroll
			}
		}
	};

	// Publicly available methods & variables
	const publicMethods = {};

	// Get an average brightness reading
	const averageBrightness = (canvas, context) => {
		const pixelData = context.getImageData(0, 0, canvas.width, canvas.height).data;
		let sum = 0;
		for (let i = 0; i < pixelData.length; i += 4) {
			sum = sum + pixelData[i] + pixelData[i + 1]; // Red and Green channels
		}
		const avg = sum / (pixelData.length * 0.5);
		return avg / 255; // Scale to 0 ... 1
	};

	// Helper function for median calculation (robust to non-numbers)
	const calculateMedian = (arr) => {
		if (!arr || arr.length === 0) return null;
		const sortedArr = [...arr].filter(val => typeof val === 'number' && !isNaN(val)).sort((a, b) => a - b);
		if (sortedArr.length === 0) return null;
		
		const mid = Math.floor(sortedArr.length / 2);
		if (sortedArr.length % 2 === 0) { // Even number of elements
			if (mid === 0 || sortedArr.length < 2) return sortedArr[0] || null; // handles edge case of 0 or 1 valid element
			return (sortedArr[mid - 1] + sortedArr[mid]) / 2;
		}
		return sortedArr[mid]; // Odd number of elements
	};
	
	const resetBpmStability = (clearLastLockedBpm = false) => {
		log("Resetting BPM Stability. Clear last locked BPM:", clearLastLockedBpm);
		rawBpmBuffer = [];
		stableBpmCandidate = null;
		stabilityCounter = 0;
		if (clearLastLockedBpm) {
			lastDisplayedBpm = null;
		}
	};

	publicMethods.initialize = (configuration) => {
		VIDEO_ELEMENT = configuration.videoElement;
		SAMPLING_CANVAS = configuration.samplingCanvas;
		GRAPH_CANVAS = configuration.graphCanvas;
		GRAPH_COLOR = configuration.graphColor;
		GRAPH_WIDTH = configuration.graphWidth;
		ON_BPM_CHANGE = configuration.onBpmChange;
		DEBUG = configuration.debug || false;

		SAMPLING_CONTEXT = SAMPLING_CANVAS.getContext("2d");
		GRAPH_CONTEXT = GRAPH_CANVAS.getContext("2d");

		if (!("mediaDevices" in navigator && navigator.mediaDevices.getUserMedia)) {
			alert("Sorry, your browser doesn't support camera access which is required by this app.");
			return false;
		}
		window.addEventListener("resize", handleResize);
		handleResize();
	};

	const handleResize = () => {
		if (!GRAPH_CANVAS) return;
		log("handleResize", GRAPH_CANVAS.clientWidth, GRAPH_CANVAS.clientHeight);
		GRAPH_CANVAS.width = GRAPH_CANVAS.clientWidth;
		GRAPH_CANVAS.height = GRAPH_CANVAS.clientHeight;
	};

	publicMethods.toggleMonitoring = () => {
		MONITORING ? stopMonitoring() : startMonitoring();
	};

	const getCamera = async () => {
		const devices = await navigator.mediaDevices.enumerateDevices();
		const cameras = devices.filter(device => device.kind === "videoinput");
		// Prefer back camera if available, otherwise take the last one.
        const backCamera = cameras.find(camera => camera.label.toLowerCase().includes('back'));
        return backCamera || cameras[cameras.length - 1];
	};

	const startMonitoring = async () => {
		resetBuffer();
		resetBpmStability(true); // Full reset of BPM state, including clearing last locked BPM

		handleResize();
		setBpmDisplay(""); // Clear display initially

		const camera = await getCamera();
		if (!camera) {
			alert("No camera found.");
			return;
		}
		
		VIDEO_STREAM = await startCameraStream(camera);

		if (!VIDEO_STREAM) {
			// Error already alerted in startCameraStream
			return;
		}

		try {
			await setTorchStatus(VIDEO_STREAM, true);
		} catch (e) {
			log("Torch enabling error (non-critical):", e.message); // Changed to log from alert
		}

		SAMPLING_CANVAS.width = IMAGE_WIDTH;
		SAMPLING_CANVAS.height = IMAGE_HEIGHT;
		VIDEO_ELEMENT.srcObject = VIDEO_STREAM;
		await VIDEO_ELEMENT.play(); // Ensure play() is awaited or handled with .then()
		MONITORING = true;

		log("Waiting before starting mainloop...");
		setTimeout(() => {
			if (!MONITORING) return; // Check if stopped during delay
			log("Starting mainloop...");
			monitorLoop();
		}, START_DELAY);
	};

	const stopMonitoring = async () => {
		if (VIDEO_STREAM) {
			await setTorchStatus(VIDEO_STREAM, false).catch(e => log("Torch disabling error:", e.message));
			VIDEO_STREAM.getTracks().forEach(track => track.stop());
		}
		VIDEO_ELEMENT.pause();
		VIDEO_ELEMENT.srcObject = null;
		MONITORING = false;
		resetBpmStability(true); // Full reset on stop
		setBpmDisplay("");
	};

	const monitorLoop = () => {
		if (!MONITORING) return;
		processFrame();
		window.requestAnimationFrame(monitorLoop);
	};

	const resetBuffer = () => {
		SAMPLE_BUFFER.length = 0;
	};

	const startCameraStream = async (camera) => {
		let stream;
		try {
			stream = await navigator.mediaDevices.getUserMedia({
				video: {
					deviceId: camera ? { exact: camera.deviceId } : undefined,
					facingMode: ["environment", "user"], // Prefer environment (back camera)
					width: { ideal: IMAGE_WIDTH * 10, max: 640 }, // Request slightly higher res from camera
					height: { ideal: IMAGE_HEIGHT * 10, max: 480 }, // then downsample in drawImage
					// Experimental constraints (might not be supported by all browsers/devices)
					// whiteBalanceMode: "manual", // Often "continuous" or "none" are more common
					// exposureMode: "manual",   // "continuous" or "none"
					// focusMode: "manual",      // "continuous" or "none"
				},
			});
		} catch (error) {
			alert("Failed to access camera!\nError: " + error.message);
			return null;
		}
		return stream;
	};

	const setTorchStatus = async (stream, status) => {
		if (!stream) return;
		const track = stream.getVideoTracks()[0];
		if (track && typeof track.applyConstraints === 'function') {
			try {
                const capabilities = track.getCapabilities();
                if (capabilities.torch) {
				    await track.applyConstraints({ advanced: [{ torch: status }] });
                    log("Torch status set to:", status);
                } else {
                    log("Torch not supported by this camera track.");
                }
			} catch (error) {
				log("Setting torch failed (non-critical). Error:", error.message); // Changed to log
			}
		} else {
            log("Torch control not available (no track or applyConstraints).");
        }
	};

	const setBpmDisplay = (bpmOrMessage) => {
		ON_BPM_CHANGE(bpmOrMessage);
	};

	const processFrame = () => {
		SAMPLING_CONTEXT.drawImage(VIDEO_ELEMENT, 0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
		const value = averageBrightness(SAMPLING_CANVAS, SAMPLING_CONTEXT);
		const time = Date.now();

		SAMPLE_BUFFER.push({ value, time });
		if (SAMPLE_BUFFER.length > MAX_SAMPLES) {
			SAMPLE_BUFFER.shift();
		}

		const dataStats = analyzeData(SAMPLE_BUFFER);
		drawGraph(dataStats);

		let currentDisplayValue;

		if (SAMPLE_BUFFER.length < MIN_SAMPLES_FOR_RELIABLE_BPM) {
			resetBpmStability(true); // Full reset, clear last locked BPM
			currentDisplayValue = "Analyzing...";
		} else if (dataStats.range < MIN_SIGNAL_RANGE_FOR_CALCULATION) {
			resetBpmStability(true); // Full reset, signal lost
			currentDisplayValue = "Low Signal";
		} else if (dataStats.crossings.length < MIN_CROSSINGS_FOR_CALCULATION) {
			resetBpmStability(false); // Partial reset, keep last locked BPM if it existed
			currentDisplayValue = lastDisplayedBpm !== null ? Math.round(lastDisplayedBpm) : "Detecting...";
		} else {
			// Conditions seem OK for BPM calculation attempt
			const currentRawBpm = calculateBpm(dataStats.crossings);

			if (currentRawBpm === null || isNaN(currentRawBpm) || currentRawBpm < 30 || currentRawBpm > 240) { // Max BPM slightly higher
				// Bad raw BPM reading. Don't add to buffer. Maintain previous display.
				if (lastDisplayedBpm !== null) {
					currentDisplayValue = Math.round(lastDisplayedBpm);
				} else if (stableBpmCandidate !== null) {
					currentDisplayValue = Math.round(stableBpmCandidate);
				} else {
					currentDisplayValue = "Hold Still";
				}
			} else {
				// Good raw BPM, process it
				rawBpmBuffer.push(currentRawBpm);
				if (rawBpmBuffer.length > RAW_BPM_BUFFER_SIZE) {
					rawBpmBuffer.shift();
				}

				if (rawBpmBuffer.length < RAW_BPM_BUFFER_SIZE / 2) {
					currentDisplayValue = lastDisplayedBpm !== null ? Math.round(lastDisplayedBpm) : "Calculating...";
				} else {
					const medianBpm = calculateMedian(rawBpmBuffer);

					if (medianBpm === null) {
						currentDisplayValue = lastDisplayedBpm !== null ? Math.round(lastDisplayedBpm) : "Error";
					} else {
						if (stableBpmCandidate === null) {
							stableBpmCandidate = medianBpm;
							stabilityCounter = 1;
							log("New BPM candidate:", stableBpmCandidate.toFixed(1));
						} else {
							if (Math.abs(medianBpm - stableBpmCandidate) <= BPM_STABILITY_TOLERANCE) {
								stabilityCounter++;
								stableBpmCandidate = (stableBpmCandidate * 0.7) + (medianBpm * 0.3); // Smooth candidate
								log("BPM candidate stable. Count:", stabilityCounter, "New candidate:", stableBpmCandidate.toFixed(1), "Median:", medianBpm.toFixed(1));
							} else {
								log("BPM candidate unstable. Old:", stableBpmCandidate.toFixed(1), "New median:", medianBpm.toFixed(1));
								stableBpmCandidate = medianBpm;
								stabilityCounter = 1;
							}
						}

						if (stabilityCounter >= REQUIRED_STABILITY_COUNT) {
							lastDisplayedBpm = stableBpmCandidate;
							currentDisplayValue = Math.round(lastDisplayedBpm);
							log("Locked BPM:", currentDisplayValue);
						} else {
							if (lastDisplayedBpm !== null) {
								currentDisplayValue = Math.round(lastDisplayedBpm);
							} else { // No locked BPM yet, show the (maturing) candidate
								currentDisplayValue = Math.round(stableBpmCandidate);
							}
						}
					}
				}
			}
		}
		setBpmDisplay(currentDisplayValue);
	};


	const analyzeData = (samples) => {
		if (samples.length === 0) {
			return { average: 0, min: 0, max: 0, range: 0, crossings: [] };
		}
		const average = samples.map(sample => sample.value).reduce((a, c) => a + c, 0) / samples.length;
		let min = samples[0].value;
		let max = samples[0].value;
		samples.forEach(sample => {
			if (sample.value > max) max = sample.value;
			if (sample.value < min) min = sample.value;
		});
		const range = max - min;
		const crossings = getAverageCrossings(samples, average);
		return { average, min, max, range, crossings };
	};

	const getAverageCrossings = (samples, average) => {
		const crossingsSamples = [];
		if (samples.length < 2) return crossingsSamples;

		let previousSample = samples[0];
		for (let i = 1; i < samples.length; i++) {
			const currentSample = samples[i];
			if (currentSample.value < average && previousSample.value >= average) { // Changed to >= for previous to catch exact average pass
				crossingsSamples.push(currentSample);
			}
			previousSample = currentSample;
		}
		return crossingsSamples;
	};

	const calculateBpm = (samples) => {
		if (samples.length < 2) {
			return null; // Not enough samples to calculate an interval
		}
		// Calculate average interval between detected crossings
		const timeDifferences = [];
		for (let i = 1; i < samples.length; i++) {
			timeDifferences.push(samples[i].time - samples[i-1].time);
		}
		
		if(timeDifferences.length === 0) return null; // Should be caught by samples.length < 2

		// Use median of intervals for robustness against outliers
		const sortedIntervals = timeDifferences.sort((a, b) => a - b);
		let medianInterval;
		const mid = Math.floor(sortedIntervals.length / 2);
		if (sortedIntervals.length % 2 === 0) {
			medianInterval = (sortedIntervals[mid - 1] + sortedIntervals[mid]) / 2;
		} else {
			medianInterval = sortedIntervals[mid];
		}

		if (medianInterval === 0 || isNaN(medianInterval)) return null; // Avoid division by zero or NaN BPM
		
		return 60000 / medianInterval;
	};

	const drawGraph = (dataStats) => {
		if (!GRAPH_CONTEXT || !GRAPH_CANVAS) return;
		const xScaling = GRAPH_CANVAS.width / MAX_SAMPLES;
		const xOffset = (MAX_SAMPLES - SAMPLE_BUFFER.length) * xScaling;

		GRAPH_CONTEXT.lineWidth = GRAPH_WIDTH;
		GRAPH_CONTEXT.strokeStyle = GRAPH_COLOR;
		GRAPH_CONTEXT.lineCap = "round";
		GRAPH_CONTEXT.lineJoin = "round";
		GRAPH_CONTEXT.clearRect(0, 0, GRAPH_CANVAS.width, GRAPH_CANVAS.height);
		
		if (SAMPLE_BUFFER.length < 2) return; // Not enough data to draw a line

		GRAPH_CONTEXT.beginPath();
		const maxHeight = GRAPH_CANVAS.height - GRAPH_CONTEXT.lineWidth * 2;
		
		SAMPLE_BUFFER.forEach((sample, i) => {
			const x = xScaling * i + xOffset;
			let y = GRAPH_CONTEXT.lineWidth;
			if (dataStats.range > 0) { // Avoid division by zero if max === min
				y = maxHeight * (1 - (sample.value - dataStats.min) / dataStats.range) + GRAPH_CONTEXT.lineWidth;
			} else { // If no range, draw flat line in the middle
                y = GRAPH_CANVAS.height / 2;
            }
			
			// Ensure y is within canvas bounds (clamping)
            y = Math.max(GRAPH_CONTEXT.lineWidth, Math.min(y, GRAPH_CANVAS.height - GRAPH_CONTEXT.lineWidth));

			if (i === 0) {
				GRAPH_CONTEXT.moveTo(x, y);
			} else {
				GRAPH_CONTEXT.lineTo(x, y);
			}
		});
		GRAPH_CONTEXT.stroke();
	};

	return publicMethods;
})();