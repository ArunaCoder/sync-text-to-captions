// --- UI Elements ---
const subtitleFileInput = document.getElementById("subtitleFile");
const revisedTextInput = document.getElementById("revisedText");
const syncButton = document.getElementById("syncButton");
const statusMessage = document.getElementById("statusMessage");
const progressBarContainer = document.getElementById("progressBarContainer");
const progressBar = document.getElementById("progressBar");

const outputSection = document.querySelector(".output-section");
const originalSrtDisplay = document.getElementById("originalSrtDisplay");
const revisedSrtDisplay = document.getElementById("revisedSrtDisplay");
const downloadButton = document.getElementById("downloadButton");

// --- State Variables ---
let originalSubtitleContent = "";
let originalSubtitleFileName = "original.srt";
let originalSubtitleFormat = "srt";
let revisedSubtitleResult = "";
let originalSubtitleHeader = "";

// --- Scoring Constants for Smith-Waterman Algorithm ---
const MATCH_SCORE = 2;
const MISMATCH_PENALTY = -1;
const GAP_PENALTY = -1;

// --- Text Processing Functions ---

/**
 * Normalize a word for alignment comparison.
 * Removes punctuation and special characters, lowercases the word.
 */
function cleanForComparison(word) {
    if (!word) return "";

    return word
        .normalize("NFC") // Normalize to composed form: combines characters and accents (e.g., "e + ́" → "é")
        .replace(/[^a-zA-ZÀ-ÿĀ-žçÇœŒßñÑ]+/g, "") // Remove everything that is not a letter, including accented letters from Latin-based scripts
        .toLowerCase(); // Convert to lowercase for case-insensitive comparison
}



/**
 * Replaces all straight quotes (") with alternating curly quotes (“ and ”).
 * Also normalizes any pre-existing curly quotes first.
 */
function replaceStraightQuotes(text) {
    text = text.replace(/[“”]/g, '"'); // Normalize existing curly quotes
    let open = true;
    return text.replace(/"/g, () => {
        const quote = open ? "“" : "”";
        open = !open;
        return quote;
    });
}




/**
 * Replace isolated hyphens surrounded by spaces with em dashes (—).
 */
function replaceHyphensWithDashes(text) {
    return text.replace(/(^|\s)-(\s)/g, "$1—$2");
}

/**
 * Normalize whitespace: collapse multiple spaces into one and trim.
 */
function normalizeSpaces(text) {
    return text.replace(/\s+/g, " ").trim();
}

/**
 * Remove all line breaks from the input text.
 */
function removeLineBreaks(text) {
    return text.replace(/\r?\n/g, " ");
}

// --- Time Conversion Functions ---

/**
 * Convert timestamp string (hh:mm:ss,ms) into milliseconds.
 * Used for SRT format.
 */
function timeToMillis(time) {
    const parts = time.split(/[:.,]/);
    if (parts.length !== 4) return 0;
    try {
        return parseInt(parts[0], 10) * 3600000 +
            parseInt(parts[1], 10) * 60000 +
            parseInt(parts[2], 10) * 1000 +
            parseInt(parts[3], 10);
    } catch (e) {
        return 0;
    }
}

/**
 * Convert milliseconds to SRT timestamp format (hh:mm:ss,ms).
 */
function millisToTimeSrt(millis) {
    const totalSeconds = Math.floor(millis / 1000);
    const ms = String(millis % 1000).padStart(3, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = String(totalMinutes % 60).padStart(2, "0");
    const hours = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
    return `${hours}:${minutes}:${seconds},${ms}`;
}

/**
 * Convert milliseconds to VTT timestamp format (hh:mm:ss.ms).
 */
function millisToTimeVtt(millis) {
    const totalSeconds = Math.floor(millis / 1000);
    const ms = String(millis % 1000).padStart(3, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    const totalMinutes = Math.floor(totalSeconds / 60);
    const minutes = String(totalMinutes % 60).padStart(2, "0");
    const hours = String(Math.floor(totalMinutes / 60)).padStart(2, "0");
    return `${hours}:${minutes}:${seconds}.${ms}`;
}

// --- Subtitle Parsing (SRT) ---

/**
 * Parse SRT file content into subtitle blocks with timestamps and text.
 */
function parseSrt(data) {
    const pattern = /(\d+)\r?\n(\d{2}:\d{2}:\d{2},\d{3}) --> (\d{2}:\d{2}:\d{2},\d{3})\r?\n([\s\S]*?)(?=\r?\n\r?\n|$)/g;
    let match;
    const subtitles = [];
    let expectedIndex = 1;

    while ((match = pattern.exec(data)) !== null) {
        const indexFromFile = parseInt(match[1], 10);
        const currentIndex = isNaN(indexFromFile) ? expectedIndex : indexFromFile;
        const textBlock = match[4];
        const flatText = textBlock.replace(/\r?\n/g, " ").trim();

        subtitles.push({
            index: currentIndex,
            startTime: match[2],
            endTime: match[3],
            startMillis: timeToMillis(match[2]),
            endMillis: timeToMillis(match[3]),
            text: flatText,
            originalTextLines: textBlock
                .split(/\r?\n/)
                .filter(line => line.trim() !== "")
        });

        expectedIndex = currentIndex + 1;
    }

    return { header: "", subtitles };
}

/**
 * Parse SBV subtitle data into an array of subtitle objects.
 * Converts SBV timestamps (with dot) into SRT format (with comma).
 */
function parseSbv(data) {
    const pattern = /(\d{1,2}:\d{2}:\d{2}\.\d{3}),(\d{1,2}:\d{2}:\d{2}\.\d{3})\r?\n([\s\S]*?)(?=\r?\n\r?\n|$)/g;
    let match;
    const subtitles = [];
    let indexCounter = 1;

    while ((match = pattern.exec(data)) !== null) {
        const startTimeSbv = match[1];
        const endTimeSbv = match[2];

        const startTimeSrt = startTimeSbv.replace(".", ",");
        const endTimeSrt = endTimeSbv.replace(".", ",");

        const textBlock = match[3];
        const flatText = textBlock.replace(/\r?\n/g, " ").trim();

        subtitles.push({
            index: indexCounter++,
            startTime: startTimeSrt,
            endTime: endTimeSrt,
            startMillis: timeToMillis(startTimeSrt),
            endMillis: timeToMillis(endTimeSrt),
            text: flatText,
            originalTextLines: textBlock.split(/\r?\n/).filter(line => line.trim() !== "")
        });
    }

    return { header: "", subtitles };
}

/**
 * Parse VTT subtitle data into an array of subtitle objects.
 * Handles optional header and supports conversion to SRT-compatible format.
 */
function parseVtt(data) {
    const lines = data.split(/\r?\n/);
    const subtitles = [];
    let indexCounter = 1;
    let currentCue = null;
    let headerLines = [];
    let inHeader = true;

    for (const line of lines) {
        const trimmedLine = line.trim();

        if (inHeader) {
            if (trimmedLine === "" && headerLines.length > 0 && headerLines[0].trim() === "WEBVTT") {
                inHeader = false;
                continue;
            }
            if (trimmedLine.includes("-->")) {
                inHeader = false;
            } else {
                headerLines.push(line);
                continue;
            }
        }

        if (!inHeader) {
            if (trimmedLine.includes("-->")) {
                // Save previous cue if exists
                if (currentCue && currentCue.originalTextLines.length > 0) {
                    currentCue.text = currentCue.originalTextLines.join(" ").trim();
                    subtitles.push(currentCue);
                }

                const [startRaw, endRaw] = trimmedLine.split("-->").map(s => s.trim());

                let startTime = startRaw;
                let endTime = endRaw.split(" ")[0].trim();

                // Normalize short times (e.g. mm:ss.xxx → hh:mm:ss.xxx)
                if (startTime.split(":").length === 2) startTime = "00:" + startTime;
                if (endTime.split(":").length === 2) endTime = "00:" + endTime;

                const startSrt = startTime.replace(".", ",");
                const endSrt = endTime.replace(".", ",");

                currentCue = {
                    index: indexCounter++,
                    startTime: startSrt,
                    endTime: endSrt,
                    startMillis: timeToMillis(startSrt),
                    endMillis: timeToMillis(endSrt),
                    text: "",
                    originalTextLines: []
                };
            } else if (currentCue && trimmedLine !== "") {
                currentCue.originalTextLines.push(trimmedLine);
            } else if (trimmedLine === "" && currentCue) {
                // End of current cue
                if (currentCue.originalTextLines.length > 0) {
                    currentCue.text = currentCue.originalTextLines.join(" ").trim();
                    subtitles.push(currentCue);
                }
                currentCue = null;
            } else if (trimmedLine !== "") {
                // Ignore cue IDs or metadata
            }
        }
    }

    // Add final cue if pending
    if (currentCue && currentCue.originalTextLines.length > 0) {
        currentCue.text = currentCue.originalTextLines.join(" ").trim();
        subtitles.push(currentCue);
    }

    return {
        header: headerLines.join("\n"),
        subtitles
    };
}
// --- Subtitle Formatting Functions (SRT, SBV, VTT) ---

/**
 * Break a long line into two lines, attempting to split near the middle at a space.
 * Falls back to splitting at the middle if no spaces are found.
 * @param {string} text - The text to split
 * @param {number} maxChars - Not used in current logic, but retained for flexibility
 * @returns {string[]} An array of one or two lines
 */
function breakLines(text, maxChars = 50) {
    if (!text || text.length <= maxChars) return [text];

    const middle = Math.floor(text.length / 2);
    const left = text.lastIndexOf(" ", middle);
    const right = text.indexOf(" ", middle);

    let splitIndex;
    if (left === -1 && right === -1) {
        // No spaces at all — split in the middle if necessary
        splitIndex = (text.length > maxChars) ? middle : -1;
        if (splitIndex === -1) return [text];
    } else if (left === -1) {
        splitIndex = right;
    } else if (right === -1) {
        splitIndex = left;
    } else {
        // Choose the nearest space to the center
        splitIndex = (middle - left <= right - middle) ? left : right;
    }

    return [
        text.slice(0, splitIndex).trim(),
        text.slice(splitIndex + 1).trim()
    ];
}

/**
 * Format subtitle objects as an SRT file string.
 */
function formatSrt({ subtitles }) {
    return subtitles.map(sub => {
        const lines = breakLines(sub.text);
        return `${sub.index}\n${millisToTimeSrt(sub.startMillis)} --> ${millisToTimeSrt(sub.endMillis)}\n${lines.join("\n")}`;
    }).join("\n\n");
}

/**
 * Format subtitle objects as an SBV file string.
 */
function formatSbv({ subtitles }) {
    return subtitles.map(sub => {
        const startTime = millisToTimeSrt(sub.startMillis).replace(",", ".");
        const endTime = millisToTimeSrt(sub.endMillis).replace(",", ".");
        const lines = breakLines(sub.text);
        return `${startTime},${endTime}\n${lines.join("\n")}`;
    }).join("\n\n");
}

/**
 * Format subtitle objects as a VTT file string.
 * Includes optional original header or defaults to "WEBVTT".
 */
function formatVtt({ header, subtitles }) {
    const vttHeader = (header && header.trim() !== "" ? header : "WEBVTT") + "\n\n";
    const cues = subtitles.map(sub => {
        const start = millisToTimeVtt(sub.startMillis);
        const end = millisToTimeVtt(sub.endMillis);
        const lines = breakLines(sub.text);
        return `${start} --> ${end}\n${lines.join("\n")}`;
    }).join("\n\n");
    return vttHeader + cues;
}
// --- Smith-Waterman Local Alignment Algorithm ---

/**
 * Build the score and traceback matrices using the Smith-Waterman algorithm.
 * @param {string[]} seq1 - First sequence (array of words)
 * @param {string[]} seq2 - Second sequence (array of words)
 * @param {number} matchScore - Score for matching words
 * @param {number} mismatchPenalty - Penalty for mismatched words
 * @param {number} gapPenalty - Penalty for insertions/deletions (gaps)
 * @returns {object} Matrices and best alignment position
 */
function smithWaterman(seq1, seq2, matchScore, mismatchPenalty, gapPenalty) {
    const n = seq1.length;
    const m = seq2.length;

    const scoreMatrix = Array(n + 1).fill(0).map(() => Array(m + 1).fill(0));
    const tracebackMatrix = Array(n + 1).fill(0).map(() => Array(m + 1).fill(null));

    let maxScore = 0;
    let maxPos = { i: 0, j: 0 };

    for (let i = 1; i <= n; i++) {
        for (let j = 1; j <= m; j++) {
            const word1 = cleanForComparison(seq1[i - 1]);
            const word2 = cleanForComparison(seq2[j - 1]);

            const match = scoreMatrix[i - 1][j - 1] + ((word1 === word2 && word1 !== "") ? matchScore : mismatchPenalty);
            const deleteGap = scoreMatrix[i - 1][j] + gapPenalty;
            const insertGap = scoreMatrix[i][j - 1] + gapPenalty;

            const currentScore = Math.max(0, match, deleteGap, insertGap);
            scoreMatrix[i][j] = currentScore;

            if (currentScore === 0) {
                tracebackMatrix[i][j] = null;
            } else if (currentScore === match) {
                tracebackMatrix[i][j] = "diag";
            } else if (currentScore === deleteGap) {
                tracebackMatrix[i][j] = "up";
            } else {
                tracebackMatrix[i][j] = "left";
            }

            if (currentScore > maxScore) {
                maxScore = currentScore;
                maxPos = { i, j };
            }
        }
    }

    return { scoreMatrix, tracebackMatrix, maxScore, maxPos };
}

/**
 * Reconstruct the best local alignment path from the traceback matrix.
 * @param {string[]} seq1 - First sequence (words)
 * @param {string[]} seq2 - Second sequence (words)
 * @param {number[][]} scoreMatrix - Matrix of alignment scores
 * @param {string[][]} tracebackMatrix - Matrix of traceback directions
 * @param {object} maxPos - Coordinates of the highest scoring cell
 * @returns {object[]} Array of alignment steps (match, mismatch, gap)
 */
function traceback(seq1, seq2, scoreMatrix, tracebackMatrix, maxPos) {
    const alignment = [];
    let { i, j } = maxPos;

    while (i > 0 && j > 0 && scoreMatrix[i][j] > 0) {
        const direction = tracebackMatrix[i][j];

        const step = {
            index1: i - 1,
            index2: j - 1,
            word1: null,
            word2: null,
            type: null
        };

        if (direction === "diag") {
            step.word1 = seq1[i - 1];
            step.word2 = seq2[j - 1];

            const w1 = cleanForComparison(step.word1);
            const w2 = cleanForComparison(step.word2);
            step.type = (w1 === w2 && w1 !== "") ? "match" : "mismatch";

            i--;
            j--;
        } else if (direction === "up") {
            step.word1 = seq1[i - 1];
            step.word2 = "-";
            step.type = "gap2"; // Gap in seq2
            i--;
        } else {
            step.word1 = "-";
            step.word2 = seq2[j - 1];
            step.type = "gap1"; // Gap in seq1
            j--;
        }

        alignment.push(step);
    }

    alignment.reverse();
    return alignment;
}
/**
 * Maps aligned words from the revised text (word2) back into original subtitle segments.
 * Preserves the segment structure from the original parsed subtitles.
 * @param {object[]} alignment - Result from traceback() with alignment steps
 * @param {object[]} parsedSubsOriginal - Original subtitle segments
 * @param {string[]} seq1Global - Flattened original words (used for indexing)
 * @returns {string[]} Aligned revised text segments, matching the original segment structure
 */
function mapAlignmentToSegments(alignment, parsedSubsOriginal, seq1Global) {
    const revisedSegments = Array(parsedSubsOriginal.length).fill("");
    const segmentBoundaries = [];

    // Step 1: Calculate start/end word indices for each original segment
    let currentWordIndex = 0;
    for (let i = 0; i < parsedSubsOriginal.length; i++) {
        const segmentWords = parsedSubsOriginal[i].text.split(" ").filter(Boolean);
        const startIndex = currentWordIndex;
        const endIndex = startIndex + segmentWords.length;
        segmentBoundaries.push({ start: startIndex, end: endIndex });
        currentWordIndex = endIndex;
    }

    // Step 2: Walk through the alignment and group word2 values by segment
    let currentSegmentIndex = 0;
    let wordsForCurrentSegment = [];

    for (const step of alignment) {
        const originalWordIndex = step.index1;

        // If current word exceeds segment end, store the current result and move on
        while (currentSegmentIndex < segmentBoundaries.length &&
            originalWordIndex >= segmentBoundaries[currentSegmentIndex].end) {
            revisedSegments[currentSegmentIndex] = wordsForCurrentSegment.join(" ");
            currentSegmentIndex++;
            wordsForCurrentSegment = [];
            if (currentSegmentIndex >= segmentBoundaries.length) break;
        }

        if (currentSegmentIndex >= segmentBoundaries.length) break;

        const boundary = segmentBoundaries[currentSegmentIndex];
        if (originalWordIndex >= boundary.start && originalWordIndex < boundary.end) {
            if (step.word2 && step.word2 !== "-") {
                wordsForCurrentSegment.push(step.word2);
            }
        }
    }

    // Step 3: Save the last collected segment
    if (currentSegmentIndex < revisedSegments.length) {
        revisedSegments[currentSegmentIndex] = wordsForCurrentSegment.join(" ");
    }

    // Step 4: Ensure all segments are at least initialized
    for (let i = 0; i < revisedSegments.length; i++) {
        if (revisedSegments[i] === undefined) {
            revisedSegments[i] = "";
        }
    }

    return revisedSegments;
}
// --- UI Functions and Event Handlers ---

/**
 * Displays both the original and revised subtitles in formatted form.
 * Also calculates and logs similarity between revised input and generated output.
 * @param {object[]} parsedSubsOriginal - Original parsed subtitle objects
 * @param {string[]} revisedSegments - Aligned revised text for each segment
 */
function displayResult(parsedSubsOriginal, revisedSegments) {
    // Format original subtitles for display
    let originalFormatFunction;
    const originalFormatArg = {
        header: originalSubtitleHeader,
        subtitles: parsedSubsOriginal
    };

    switch (originalSubtitleFormat) {
        case "sbv":
            originalFormatFunction = formatSbv;
            break;
        case "vtt":
            originalFormatFunction = formatVtt;
            break;
        case "srt":
        default:
            originalFormatFunction = formatSrt;
            break;
    }

    const formattedOriginalContent = originalFormatFunction(originalFormatArg);
    originalSrtDisplay.textContent = formattedOriginalContent;

    // Create revised subtitle objects by injecting revised text into parsed segments
    const revisedSubtitles = parsedSubsOriginal.map((sub, index) => ({
        ...sub,
        text: revisedSegments[index] || ""
    }));

    let revisedFormatFunction;
    const revisedFormatArg = {
        header: originalSubtitleHeader,
        subtitles: revisedSubtitles
    };

    switch (originalSubtitleFormat) {
        case "sbv":
            revisedFormatFunction = formatSbv;
            break;
        case "vtt":
            revisedFormatFunction = formatVtt;
            break;
        case "srt":
        default:
            revisedFormatFunction = formatSrt;
            break;
    }

    // Generate final subtitle file and raw text version
    revisedSubtitleResult = revisedFormatFunction(revisedFormatArg);
    const revisedPlainText = getPlainTextFromSrt(revisedSubtitleResult);

    // Compare the plain revised text to the user-provided input
    const originalRevisedText = normalizeSpaces(removeLineBreaks(revisedTextInput.value));
    const score = calculateSimilarity(revisedPlainText, originalRevisedText);

    console.log(
        "Final similarity score between revised input and generated subtitle:",
        score.toFixed(2) + "%"
    );

    // Show revised subtitle in output
    revisedSrtDisplay.value = revisedSubtitleResult;
    outputSection.style.display = "block";
}
/**
 * Main sync handler triggered on button click.
 * Parses subtitle file, prepares the text, runs Smith-Waterman, and maps output to segments.
 */
function handleSync() {
    const revisedText = revisedTextInput.value;

    if (!originalSubtitleContent || !revisedText) {
        statusMessage.textContent = "Error: Please upload a subtitle file and paste the revised text.";
        return;
    }

    statusMessage.textContent = "Lining things up nicely...";
    outputSection.style.display = "none";
    progressBarContainer.style.display = "block";
    progressBar.value = 0;

    try {
        // Step 1: Parse the original subtitle file
        let parsedResult;
        let parseFunction;

        switch (originalSubtitleFormat) {
            case "sbv":
                parseFunction = parseSbv;
                break;
            case "vtt":
                parseFunction = parseVtt;
                break;
            case "srt":
            default:
                parseFunction = parseSrt;
                break;
        }

        parsedResult = parseFunction(originalSubtitleContent);
        const parsedSubsOriginal = parsedResult.subtitles;
        originalSubtitleHeader = parsedResult.header;

        if (!parsedSubsOriginal || parsedSubsOriginal.length === 0) {
            throw new Error(`Invalid or empty ${originalSubtitleFormat.toUpperCase()} file.`);
        }

        // Step 2: Prepare sequences for alignment
        const seq1Global = parsedSubsOriginal.flatMap(sub =>
            sub.text.split(" ").filter(Boolean)
        );

        let revisedProcessed = replaceStraightQuotes(revisedText);
        revisedProcessed = replaceHyphensWithDashes(revisedProcessed);
        let revisedClean = removeLineBreaks(revisedProcessed);
        revisedClean = normalizeSpaces(revisedClean);

        const seq2Global = revisedClean.split(" ").filter(Boolean);

        if (seq1Global.length === 0 || seq2Global.length === 0) {
            throw new Error("One of the word sequences (original or revised) is empty.");
        }

        progressBar.value = 10;
        statusMessage.textContent = "Finding the best way to match your words...";


        setTimeout(() => {
            try {
                // Step 3: Run Smith-Waterman algorithm
                const { scoreMatrix, tracebackMatrix, maxScore, maxPos } = smithWaterman(
                    seq1Global,
                    seq2Global,
                    MATCH_SCORE,
                    MISMATCH_PENALTY,
                    GAP_PENALTY
                );

                progressBar.value = 50;
                statusMessage.textContent = "Performing traceback...";

                const alignment = traceback(seq1Global, seq2Global, scoreMatrix, tracebackMatrix, maxPos);

                progressBar.value = 80;
                statusMessage.textContent = "Mapping alignment to segments...";

                const revisedSegments = mapAlignmentToSegments(alignment, parsedSubsOriginal, seq1Global);

                // Step 4: Compare full synced output to original revised input
                const finalSyncedText = revisedSegments.join(" ");
                const finalWords = finalSyncedText.split(" ").filter(Boolean);

                let revisedFlat = replaceStraightQuotes(revisedText);
                revisedFlat = replaceHyphensWithDashes(revisedFlat);
                revisedFlat = removeLineBreaks(revisedFlat);
                revisedFlat = normalizeSpaces(revisedFlat);

                const revisedWords = revisedFlat.split(" ").filter(Boolean);

                // Attempt to recover truly missing initial words by comparing against only the first segment
                const syncedFirstSegmentWords = revisedSegments[0]
                    .split(" ")
                    .filter(Boolean)
                    .map(cleanForComparison);

                const missingPrefix = [];

                for (let i = 0; i < revisedWords.length; i++) {
                    const cleaned = cleanForComparison(revisedWords[i]);

                    // Stop at the first word that is already present in the first segment
                    if (syncedFirstSegmentWords.includes(cleaned)) {
                        break;
                    }

                    // Otherwise, collect it as missing
                    missingPrefix.push(revisedWords[i]);
                }

                // Manually prepend missing words to the first segment
                if (missingPrefix.length > 0) {
                    revisedSegments[0] = missingPrefix.join(" ") + " " + revisedSegments[0];
                }

                // Calculate similarity score for diagnostic purposes
                let matched = 0;
                for (let i = 0; i < Math.min(revisedWords.length, finalWords.length); i++) {
                    if (
                        cleanForComparison(revisedWords[i]) ===
                        cleanForComparison(finalWords[i])
                    ) {
                        matched++;
                    }
                }

                const score = Math.round((matched / revisedWords.length) * 100);
                statusMessage.textContent += ` | Match Score: ${score}%`;

                console.log("Alignment finished successfully.");
                console.log("Checking if revised text was preserved...");

                // Step 5: Display results
                displayResult(parsedSubsOriginal, revisedSegments);
                statusMessage.textContent = "Sync complete! Take a look 🎉";

                progressBar.value = 100;

                // Auto-scroll to output
                outputSection.scrollIntoView({ behavior: "smooth" });
            } catch (swError) {
                console.error("Unexpected error during text matching:", swError);

                statusMessage.textContent = `SW Error: ${swError.message}`;
                progressBarContainer.style.display = "none";
            }
        }, 50);


    } catch (error) {
        console.error("Error during preparation phase:", error);
        statusMessage.textContent = `Preparation Error: ${error.message}`;
        outputSection.style.display = "none";
        progressBarContainer.style.display = "none";
    }
}
/**
 * Extracts plain text from an SRT file by removing indices and timestamps.
 * Joins all text lines into a single normalized string.
 * @param {string} srtContent - Full content of the SRT file
 * @returns {string} Normalized plain text
 */
function getPlainTextFromSrt(srtContent) {
    return srtContent
        .replace(/^\d+\s*$/gm, "") // remove index lines
        .replace(/^\d{2}:\d{2}:\d{2}[.,]\d{3} --> \d{2}:\d{2}:\d{2}[.,]\d{3}$/gm, "") // remove timestamp lines
        .replace(/\r?\n/g, " ") // join lines
        .replace(/\s+/g, " ") // normalize spaces
        .trim();
}

/**
 * Calculates similarity score between two strings by comparing word-by-word equality.
 * Includes console debugging for the first and last 30 words.
 * @param {string} text1 - First text string
 * @param {string} text2 - Second text string
 * @returns {number} Percentage similarity score (0–100)
 */
function calculateSimilarity(text1, text2) {
    const normalize = str =>
        str.replace(/[.,“”"`?!:;()\[\]{}]/g, "")
            .toLowerCase()
            .replace(/\s+/g, " ")
            .trim();

    const words1 = normalize(text1).split(" ");
    const words2 = normalize(text2).split(" ");

    let matches = 0;
    const total = Math.max(words1.length, words2.length);

    // Debug helper: logs side-by-side comparison
    function debugSegment(w1, w2, label) {
        console.log(`--- ${label} ---`);
        for (let i = 0; i < w1.length; i++) {
            const a = w1[i] || "(empty)";
            const b = w2[i] || "(empty)";
            console.log(`Comparing: "${a}" vs "${b}"`);
        }
    }

    // Logs: beginning
    debugSegment(words1.slice(0, 30), words2.slice(0, 30), "First 30 words");

    if (total > 60) console.log("... [comparison continues] ...");

    // Logs: end
    debugSegment(words1.slice(-30), words2.slice(-30), "Last 30 words");

    // Main comparison
    for (let i = 0; i < total; i++) {
        if ((words1[i] || "") === (words2[i] || "")) matches++;
    }

    return total === 0 ? 0 : (matches / total) * 100;
}
/**
 * Creates and triggers download of the revised subtitle content in original format.
 */
function handleDownload() {
    const finalSubtitleContent = revisedSrtDisplay.value;
    if (!finalSubtitleContent) return;

    const blob = new Blob([finalSubtitleContent], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    const baseName = originalSubtitleFileName.replace(/\.(srt|sbv|vtt)$/i, "");
    a.download = `${baseName}_revised.${originalSubtitleFormat}`;

    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// --- Synced Scroll Logic ---
let isSyncingScroll = false; // Flag to prevent infinite loop

function syncScroll(sourceElement, targetElement) {
    if (isSyncingScroll) return;
    isSyncingScroll = true;

    const sourceScrollTop = sourceElement.scrollTop;
    const sourceScrollHeight = sourceElement.scrollHeight - sourceElement.clientHeight;
    const targetScrollHeight = targetElement.scrollHeight - targetElement.clientHeight;

    if (sourceScrollHeight > 0 && targetScrollHeight > 0) {
        const scrollRatio = sourceScrollTop / sourceScrollHeight;
        targetElement.scrollTop = scrollRatio * targetScrollHeight;
    }

    // Reset flag on the next animation frame to avoid scroll ping-pong
    requestAnimationFrame(() => {
        isSyncingScroll = false;
    });
}

originalSrtDisplay.addEventListener("scroll", () => {
    syncScroll(originalSrtDisplay, revisedSrtDisplay);
});

revisedSrtDisplay.addEventListener("scroll", () => {
    syncScroll(revisedSrtDisplay, originalSrtDisplay);
});

// --- File Input Handler ---
subtitleFileInput.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) {
        originalSubtitleFileName = file.name;
        const reader = new FileReader();
        const extension = originalSubtitleFileName.split(".").pop().toLowerCase();

        if (["srt", "sbv", "vtt"].includes(extension)) {
            originalSubtitleFormat = extension;
        } else {
            statusMessage.textContent = "Error: Unsupported file format. Please use SRT, SBV, or VTT.";
            originalSubtitleContent = "";
            subtitleFileInput.value = "";
            return;
        }

        reader.onload = (e) => {
            originalSubtitleContent = e.target.result;
            statusMessage.textContent = `File loaded (${originalSubtitleFormat.toUpperCase()}). Paste the revised text and click 'Sync'.`;
            outputSection.style.display = "none";
        };

        reader.onerror = (e) => {
            console.error("Failed to read file:", e);
            statusMessage.textContent = `Error reading ${originalSubtitleFormat.toUpperCase()} file.`;
            originalSubtitleContent = "";
        };

        reader.readAsText(file, "UTF-8");
    } else {
        originalSubtitleContent = "";
        statusMessage.textContent = "No subtitle file selected.";
    }
});

// --- Button Event Bindings ---
syncButton.addEventListener("click", handleSync);
downloadButton.addEventListener("click", handleDownload);
