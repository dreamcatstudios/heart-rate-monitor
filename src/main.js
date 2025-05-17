"use strict";

const heartRateMonitor = (function () {
	// Size of sampling image
	const IMAGE_WIDTH = 30;
	const IMAGE_HEIGHT = 30;

	// Array of measured samples
	const SAMPLE_BUFFER = [];

	// Max 5 seconds of samples (at 60 samples per second)
	const MAX_SAMPLES = 60 * 5;
	const START_DELAY = 1500;
	let ON_BPM_CHANGE;
	let VIDEO_ELEMENT;
	let SAMPLING_CANVAS, SAMPLING_CONTEXT;
	let GRAPH_CANVAS, GRAPH_CONTEXT;
	let GRAPH_COLOR, GRAPH_WIDTH;
	let DEBUG = false;
	let VIDEO_STREAM;
	let MONITORING = false;

	// --- Parameters for BPM Stabilization & Signal Quality ---
	const MIN_SAMPLES_FOR_ANALYSIS = MAX_SAMPLES / 3; // Need at least this many samples in buffer
	const MIN_SIGNAL_RANGE = 0.0015;                 // Min peak-to-peak amplitude of the signal
    const MAX_SIGNAL_STD_DEV_RATIO = 0.35;           // Max standard deviation relative to signal range (filters excessive noise)
	const MIN_CROSSINGS_FOR_RAW_BPM = 4;             // Min upward zero-crossings for a raw BPM calculation
    
    const RAW_BPM_VALIDITY_WINDOW_MS = 2000;         // How long (ms) raw BPMs are considered "recent"
	const RAW_BPM_CONSISTENCY_THRESHOLD = 10;        // Max BPM difference for raw BPMs to be considered consistent
	const MIN_CONSISTENT_RAW_BPMS_FOR_CANDIDATE = 3; // How many consistent raw BPMs needed to form a candidate median
    
	const STABLE_BPM_CANDIDATE_BUFFER_SIZE = 5;      // Number of "candidate medians" to consider for final BPM
	const REQUIRED_STABILITY_COUNT = 3;              // How many "stable candidate medians" needed to lock BPM
	const BPM_STABILITY_TOLERANCE = 3;               // Max difference for candidate medians to be stable

    // State variables
    let recentValidRawBpms = []; // Stores { bpm, time, signalRange }
    let stableBpmCandidateBuffer = [];
	let currentStableBpmCandidate = null;
	let currentStabilityCounter = 0;
	let lockedBpm = null;
    let lastSignalQualityStatus = "";
    // --- End of Parameters & State ---

	const log = (...args) => {
		if (DEBUG) {
			console.log(...args);
			const debugLogEl = document.querySelector("#debug-log");
			if (debugLogEl) {
				debugLogEl.innerHTML += args.map(String).join(" ") + "<br />";
				debugLogEl.scrollTop = debugLogEl.scrollHeight;
			}
		}
	};

	const publicMethods = {};

    // Helper: Calculate standard deviation
    const calculateStdDev = (arr, mean) => {
        if (!arr || arr.length === 0) return 0;
        const variance = arr.reduce((acc, val) => acc + Math.pow(val - mean), 0) / arr.length;
        return Math.sqrt(variance);
    };

	const averageBrightness = (canvas, context) => {
		const pixelData = context.getImageData(0, 0, canvas.width, canvas.height).data;
		let sum = 0;
		for (let i = 0; i < pixelData.length; i += 4) {
			sum = sum + pixelData[i] + pixelData[i + 1];
		}
		const avg = sum / (pixelData.length * 0.5);
		return avg / 255;
	};

	const calculateMedian = (arr) => {
		if (!arr || arr.length === 0) return null;
		const sortedArr = [...arr].filter(val => typeof val === 'number' && !isNaN(val)).sort((a, b) => a - b);
		if (sortedArr.length === 0) return null;
		const mid = Math.floor(sortedArr.length / 2);
		if (sortedArr.length % 2 === 0) {
			if (mid === 0 || sortedArr.length < 2) return sortedArr[0] || null;
			return (sortedArr[mid - 1] + sortedArr[mid]) / 2;
		}
		return sortedArr[mid];
	};
	
	const resetMeasurementState = (clearLocked = true) => {
		log("Resetting Measurement State. Clear locked BPM:", clearLocked);
        recentValidRawBpms = [];
        stableBpmCandidateBuffer = [];
        currentStableBpmCandidate = null;
        currentStabilityCounter = 0;
		if (clearLocked) {
			lockedBpm = null;
		}
        lastSignalQualityStatus = "";
	};

	publicMethods.initialize = (configuration) => {
		VIDEO_ELEMENT = configuration.videoElement;
		SAMPLING_CANVAS = configuration.samplingCanvas;
		GRAPH_CANVAS = configuration.graphCanvas;
		GRAPH_COLOR = configuration.graphColor;
		GRAPH_WIDTH = configuration.graphWidth;
		ON_BPM_CHANGE = configuration.onBpmChange;
		DEBUG = configuration.debug || false;

        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            const errorMsg = "Camera access not supported. Use localhost/HTTPS.";
            alert(errorMsg); console.error(errorMsg);
            if (ON_BPM_CHANGE) ON_BPM_CHANGE("Camera Error");
            return false;
        }
        if (DEBUG) log("navigator.mediaDevices object:", navigator.mediaDevices);

		SAMPLING_CONTEXT = SAMPLING_CANVAS.getContext("2d");
		GRAPH_CONTEXT = GRAPH_CANVAS.getContext("2d");
		window.addEventListener("resize", handleResize);
		handleResize();
        return true;
	};

	const handleResize = () => {
		if (!GRAPH_CANVAS || !GRAPH_CONTEXT) return;
		GRAPH_CANVAS.width = GRAPH_CANVAS.clientWidth;
		GRAPH_CANVAS.height = GRAPH_CANVAS.clientHeight;
	};

	publicMethods.toggleMonitoring = () => {
		MONITORING ? stopMonitoring() : startMonitoring();
	};

    const getCamera = async () => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) {
            log("enumerateDevices is not supported."); return null;
        }
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            const cameras = devices.filter(device => device.kind === 'videoinput');
            if (cameras.length === 0) { log("No video input devices found."); return null; }
            const backCamera = cameras.find(camera => camera.label && camera.label.toLowerCase().includes('back'));
            if (backCamera) { log("Found back camera:", backCamera.label); return backCamera; }
            log("Using first available camera:", cameras[0].label); return cameras[0];
        } catch (err) { log("Error enumerating devices:", err); return null; }
    };

	const startMonitoring = async () => {
		resetBuffer();
		resetMeasurementState(true); // Full reset
		handleResize();
		setBpmDisplay("Starting...");

		const cameraInfo = await getCamera();
		VIDEO_STREAM = await startCameraStream(cameraInfo);

		if (!VIDEO_STREAM) {
			log("Failed to start video stream."); return;
		}
		try { await setTorchStatus(VIDEO_STREAM, true); }
        catch (e) { log("Torch enabling error:", e.message); }

		SAMPLING_CANVAS.width = IMAGE_WIDTH;
		SAMPLING_CANVAS.height = IMAGE_HEIGHT;
		VIDEO_ELEMENT.srcObject = VIDEO_STREAM;
		try { await VIDEO_ELEMENT.play(); }
        catch (playError) {
            log("Error playing video:", playError); setBpmDisplay("Video Error");
            stopMonitoring(); return;
        }
		MONITORING = true;
		log("Waiting before starting mainloop...");
		setTimeout(() => {
			if (!MONITORING) return;
			log("Starting mainloop...");
			monitorLoop();
		}, START_DELAY);
	};

	const stopMonitoring = async () => {
        MONITORING = false;
		if (VIDEO_STREAM) {
			await setTorchStatus(VIDEO_STREAM, false).catch(e => log("Torch disabling error:", e.message));
			VIDEO_STREAM.getTracks().forEach(track => track.stop());
            VIDEO_STREAM = null;
		}
		if (VIDEO_ELEMENT) { VIDEO_ELEMENT.pause(); VIDEO_ELEMENT.srcObject = null; }
		resetMeasurementState(true); // Full reset
		setBpmDisplay(""); // Clear display
        log("Monitoring stopped.");
	};

	const monitorLoop = () => {
		if (!MONITORING) return;
		processFrame();
		window.requestAnimationFrame(monitorLoop);
	};

	const resetBuffer = () => { SAMPLE_BUFFER.length = 0; };

    const tryGetUserMedia = async (constraints) => { /* ... (same as before) ... */ 
        log("Attempting getUserMedia with constraints:", JSON.stringify(constraints));
        try {
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            log("getUserMedia successful with current constraints.");
            if (stream) {
                const track = stream.getVideoTracks()[0];
                if (track) {
                    const settings = track.getSettings();
                    log("Actual camera settings obtained:", JSON.stringify(settings));
                }
            }
            return stream;
        } catch (error) {
            log(`getUserMedia failed for constraints: ${JSON.stringify(constraints)}. Error: ${error.name} - ${error.message}`);
            if (error.name === "OverconstrainedError") {
                const supportedConstraints = navigator.mediaDevices.getSupportedConstraints();
                log("Supported constraints by browser:", JSON.stringify(supportedConstraints));
            }
            throw error;
        }
    };
	const startCameraStream = async (camera) => { /* ... (same as before, using tryGetUserMedia) ... */ 
        let stream = null;
        let lastError = null;

        if (camera && camera.deviceId) {
            try {
                const constraints = { video: { deviceId: { exact: camera.deviceId } } };
                stream = await tryGetUserMedia(constraints);
                return stream;
            } catch (error) { lastError = error; log(`Attempt 1 (exact deviceId ${camera.deviceId}) failed.`);}
        }
        try {
            const constraints = { video: { facingMode: ["environment", "user"], width: { ideal: IMAGE_WIDTH * 10 }, height: { ideal: IMAGE_HEIGHT * 10 } } };
            stream = await tryGetUserMedia(constraints);
            return stream;
        } catch (error) { lastError = error; log("Attempt 2 (facingMode and ideal resolution) failed."); }
        try {
            const constraints = { video: true };
            stream = await tryGetUserMedia(constraints);
            return stream;
        } catch (error) { lastError = error; log("Attempt 3 (basic video:true) failed.");}

        if (lastError) {
            console.error("All attempts to start camera stream failed. Last error:", lastError);
            let alertMessage = "Failed to access camera!\n";
            if (lastError.name) { alertMessage += `Name: ${lastError.name}\n`; }
            if (lastError.message) { alertMessage += `Message: ${lastError.message}\n`; }
            alert(alertMessage);
            if (ON_BPM_CHANGE) ON_BPM_CHANGE("Camera Error");
        }
        return null;
    };
	const setTorchStatus = async (stream, status) => { /* ... (same as before) ... */ 
		if (!stream || !stream.active) { log("Torch control: Stream not available."); return; }
		const track = stream.getVideoTracks()[0];
		if (track && typeof track.applyConstraints === 'function') {
			try {
                const capabilities = track.getCapabilities();
                if (capabilities.torch) {
				    await track.applyConstraints({ advanced: [{ torch: status }] });
                    log("Torch status set to:", status);
                } else { log("Torch not supported."); }
			} catch (error) { log("Setting torch failed:", error.message);	}
		} else { log("Torch control not available."); }
    };
	const setBpmDisplay = (bpmOrMessage) => { if (ON_BPM_CHANGE) { ON_BPM_CHANGE(bpmOrMessage); } };

    const analyzeSignalQuality = (samples, dataStats) => {
        if (samples.length < MIN_SAMPLES_FOR_ANALYSIS) {
            return { good: false, status: "Analyzing..." };
        }
        if (dataStats.range < MIN_SIGNAL_RANGE) {
            return { good: false, status: "Low Signal (Place finger firmly)" };
        }
        const sampleValues = samples.map(s => s.value);
        const stdDev = calculateStdDev(sampleValues, dataStats.average);
        if (dataStats.range > 0 && (stdDev / dataStats.range) > MAX_SIGNAL_STD_DEV_RATIO) {
            return { good: false, status: "Noisy Signal (Hold still)" };
        }
        if (dataStats.crossings.length < MIN_CROSSINGS_FOR_RAW_BPM) {
            return { good: false, status: "Detecting Pulse..." };
        }
        return { good: true, status: "Good Signal" };
    };

	const processFrame = () => {
		if (!VIDEO_ELEMENT || VIDEO_ELEMENT.paused || VIDEO_ELEMENT.ended || VIDEO_ELEMENT.readyState < 3) {
            return;
        }
		SAMPLING_CONTEXT.drawImage(VIDEO_ELEMENT, 0, 0, IMAGE_WIDTH, IMAGE_HEIGHT);
		const currentTime = Date.now();
		const currentBrightness = averageBrightness(SAMPLING_CANVAS, SAMPLING_CONTEXT);

		SAMPLE_BUFFER.push({ value: currentBrightness, time: currentTime });
		if (SAMPLE_BUFFER.length > MAX_SAMPLES) {
			SAMPLE_BUFFER.shift();
		}

		const dataStats = analyzeData(SAMPLE_BUFFER);
		drawGraph(dataStats);

        const signal = analyzeSignalQuality(SAMPLE_BUFFER, dataStats);

        if (!signal.good) {
            if (signal.status !== lastSignalQualityStatus) { // Update display only on status change
                setBpmDisplay(signal.status);
                lastSignalQualityStatus = signal.status;
            }
            // If signal was good and we had a locked BPM, keep it for a bit, otherwise reset.
            if (lockedBpm !== null) {
                 // Optionally, could add a timeout here to clear lockedBpm if signal stays bad.
                 // For now, we let it persist until explicitly reset by prolonged bad signal or new lock.
            } else {
                 resetMeasurementState(false); // Reset candidates, but keep lockedBpm if it existed and signal just dropped
            }
            return; // Don't attempt BPM calculation with bad signal
        }
        
        // Signal is good, proceed with BPM calculation
        lastSignalQualityStatus = signal.status; // Store good status

        const rawBpm = calculateBpm(dataStats.crossings);

        if (rawBpm !== null && rawBpm >= 30 && rawBpm <= 220) {
            // Add current valid raw BPM to recent list
            recentValidRawBpms.push({ bpm: rawBpm, time: currentTime, range: dataStats.range });
            // Filter out old raw BPMs
            recentValidRawBpms = recentValidRawBpms.filter(rb => currentTime - rb.time < RAW_BPM_VALIDITY_WINDOW_MS);

            // Check for consistency among recent raw BPMs
            if (recentValidRawBpms.length >= MIN_CONSISTENT_RAW_BPMS_FOR_CANDIDATE) {
                const recentBpmsOnly = recentValidRawBpms.map(rb => rb.bpm);
                const minRecent = Math.min(...recentBpmsOnly);
                const maxRecent = Math.max(...recentBpmsOnly);

                if ((maxRecent - minRecent) <= RAW_BPM_CONSISTENCY_THRESHOLD) {
                    const candidateMedianBpm = calculateMedian(recentBpmsOnly);
                    if (candidateMedianBpm) {
                        stableBpmCandidateBuffer.push(candidateMedianBpm);
                        if (stableBpmCandidateBuffer.length > STABLE_BPM_CANDIDATE_BUFFER_SIZE) {
                            stableBpmCandidateBuffer.shift();
                        }
                        log("New Candidate Median BPM:", candidateMedianBpm.toFixed(1), "Buffer:", stableBpmCandidateBuffer.map(b=>b.toFixed(1)));
                    }
                } else {
                    log("Recent raw BPMs inconsistent:", recentBpmsOnly.map(b=>b.toFixed(1)));
                }
            }
        } else if (rawBpm !== null) {
            log("Raw BPM out of physiological range:", rawBpm.toFixed(1));
        }


        // Attempt to lock BPM based on stable candidate medians
        if (stableBpmCandidateBuffer.length >= REQUIRED_STABILITY_COUNT) { // Need enough candidates to evaluate stability
            const medianOfCandidates = calculateMedian(stableBpmCandidateBuffer);
            if (medianOfCandidates) {
                if (currentStableBpmCandidate === null) {
                    currentStableBpmCandidate = medianOfCandidates;
                    currentStabilityCounter = 1;
                    log("New Stable Candidate:", currentStableBpmCandidate.toFixed(1));
                } else {
                    if (Math.abs(medianOfCandidates - currentStableBpmCandidate) <= BPM_STABILITY_TOLERANCE) {
                        currentStabilityCounter++;
                        // Gently adjust candidate towards new median
                        currentStableBpmCandidate = (currentStableBpmCandidate * 0.7) + (medianOfCandidates * 0.3);
                        log("Stable Candidate consistent. Count:", currentStabilityCounter, "Updated Candidate:", currentStableBpmCandidate.toFixed(1));
                    } else {
                        log("Stable Candidate shifted. Old:", currentStableBpmCandidate.toFixed(1), "New Median of Candidates:", medianOfCandidates.toFixed(1));
                        currentStableBpmCandidate = medianOfCandidates;
                        currentStabilityCounter = 1; // Reset counter
                    }
                }

                if (currentStabilityCounter >= REQUIRED_STABILITY_COUNT) {
                    lockedBpm = Math.round(currentStableBpmCandidate);
                    setBpmDisplay(lockedBpm);
                    log("BPM LOCKED:", lockedBpm);
                    // Optionally, reset buffers slightly to allow re-evaluation if things change, or let them naturally phase out
                    // stableBpmCandidateBuffer = []; // Or just let it be replaced
                } else {
                    // Not locked yet, display current candidate or last locked
                    if (lockedBpm !== null) {
                        setBpmDisplay(lockedBpm); // Keep showing last locked if not re-locked yet
                    } else if (currentStableBpmCandidate !== null) {
                        setBpmDisplay(Math.round(currentStableBpmCandidate) + "?"); // Indicate it's a candidate
                    } else {
                        setBpmDisplay("Calculating...");
                    }
                }
            }
        } else {
            // Not enough candidate medians for stability check
            if (lockedBpm !== null) {
                setBpmDisplay(lockedBpm);
            } else {
                setBpmDisplay("Detecting...");
            }
        }
	};

	const analyzeData = (samples) => { /* ... (same as before) ... */ 
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
		const crossings = getAverageCrossings(samples, average); // Use the raw crossings
		return { average, min, max, range, crossings };
    };

	const getAverageCrossings = (samples, average) => { /* ... (same as before) ... */ 
		const crossingsSamples = [];
		if (samples.length < 2) return crossingsSamples;
		let previousSample = samples[0];
		for (let i = 1; i < samples.length; i++) {
			const currentSample = samples[i];
			// Detect upward crossing of the average
			if (currentSample.value > average && previousSample.value <= average) {
				crossingsSamples.push(currentSample);
			}
			previousSample = currentSample;
		}
		return crossingsSamples;
    };

	const calculateBpm = (crossingSamples) => { // Renamed parameter for clarity
		if (crossingSamples.length < 2) { return null; }
		const timeDifferences = [];
		for (let i = 1; i < crossingSamples.length; i++) {
			timeDifferences.push(crossingSamples[i].time - crossingSamples[i-1].time);
		}
		if(timeDifferences.length === 0) return null;
        // Filter out extreme intervals (e.g., <250ms (240bpm) or >2000ms (30bpm)) before median
        const physiologicallyPlausibleIntervals = timeDifferences.filter(dt => dt > 270 && dt < 2000);
        if (physiologicallyPlausibleIntervals.length < 1) return null; // Not enough plausible intervals

		const medianInterval = calculateMedian(physiologicallyPlausibleIntervals);
		if (medianInterval <= 0 || isNaN(medianInterval)) return null;
		return 60000 / medianInterval;
	};

	const drawGraph = (dataStats) => { /* ... (same as before) ... */ 
		if (!GRAPH_CONTEXT || !GRAPH_CANVAS || !SAMPLE_BUFFER) return;
		const xScaling = GRAPH_CANVAS.width / MAX_SAMPLES;
		const xOffset = (MAX_SAMPLES - SAMPLE_BUFFER.length) * xScaling;
		GRAPH_CONTEXT.lineWidth = GRAPH_WIDTH;
		GRAPH_CONTEXT.strokeStyle = GRAPH_COLOR;
		GRAPH_CONTEXT.lineCap = "round"; GRAPH_CONTEXT.lineJoin = "round";
		GRAPH_CONTEXT.clearRect(0, 0, GRAPH_CANVAS.width, GRAPH_CANVAS.height);
		if (SAMPLE_BUFFER.length < 2) return;
		GRAPH_CONTEXT.beginPath();
		const maxHeight = GRAPH_CANVAS.height - GRAPH_CONTEXT.lineWidth * 2;
		SAMPLE_BUFFER.forEach((sample, i) => {
			const x = xScaling * i + xOffset;
			let y = GRAPH_CONTEXT.lineWidth;
			if (dataStats.range > 1e-9) {
				y = maxHeight * (1 - (sample.value - dataStats.min) / dataStats.range) + GRAPH_CONTEXT.lineWidth;
			} else { y = GRAPH_CANVAS.height / 2; }
            y = Math.max(GRAPH_CONTEXT.lineWidth, Math.min(y, GRAPH_CANVAS.height - GRAPH_CONTEXT.lineWidth));
			if (i === 0) { GRAPH_CONTEXT.moveTo(x, y); } else { GRAPH_CONTEXT.lineTo(x, y); }
		});
		GRAPH_CONTEXT.stroke();
    };

	return publicMethods;
})();