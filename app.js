import { t, tr, getLang, setLang, htmlLanguage } from "./i18n.js";

const ACT_NOTE = 1;
const ACT_OK = 2;
const ACT_FAIL = 3;
const ACT_CAM = 4;
const ACT_CAM_ECHO = 5;
const MID_DOWNLOAD = 0x19;
const LOOP = new Set(["enrollFace", "identifyFace", "enrollPv"]);
const LINK_BAUD = 115200;
const CAM_BAUD = 921600;
const FACE_ID = 1;
const PALM_ID = 1;
const CAM_W = 480;
const CAM_H = 640;
const CAM_ROT = 90;
const CAM_SCALE = 1;

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const cmdLog = $("cmdLog");
const resultLog = $("resultLog");
const paramLog = $("paramLog");
const canvas = $("view");
const ctx = canvas.getContext("2d");

let wasm = null;
let ports = [];
let port = null;
let reader = null;
let writer = null;
let readTask = null;
let writeChain = Promise.resolve();
let rx = [];
let rxNotify = null;
let closing = false;
let running = false;
let stopFlag = false;
let resetSent = false;
let statusSource = "Add a port, then open it.";
let bootSource = "Loading…";

function setStatus(text) {
  statusSource = text;
  statusEl.textContent = tr(text);
}

function setBoot(text) {
  bootSource = text;
  $("boot").textContent = tr(text);
}

function applyLanguage() {
  document.documentElement.lang = htmlLanguage();
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    el.textContent = t(el.dataset.i18n);
  });
  $("boot").textContent = tr(bootSource);
  statusEl.textContent = tr(statusSource);
  const file = $("imageFile").files[0];
  if (!file) $("imageName").textContent = t("noImage");
  const empty = $("portList").querySelector("option[value='']");
  if (empty && !ports.length) empty.textContent = t("noPort");
}

function pad(n) {
  return String(n).padStart(3, "0");
}

function selected() {
  const el = document.querySelector('input[name="cmd"]:checked');
  return el ? el.value : "";
}

function syncImageRow() {
  const row = $("imageRow");
  const file = $("imageFile").files[0];
  row.hidden = selected() !== "download";
  $("imageName").textContent = file ? file.name : t("noImage");
}

function toHex(bytes) {
  let text = "";
  for (let i = 0; i < bytes.length; i++) {
    text += ` ${bytes[i].toString(16).toUpperCase().padStart(2, "0")}`;
    if (i % 20 === 19 && i < bytes.length - 1) text += "\n";
  }
  return text;
}

function appendLog(el, line) {
  let text = el.value;
  if (text.length > 64 * 1024) {
    const cut = text.indexOf("\n");
    text = cut >= 0 ? text.slice(cut + 1) : "";
  }
  el.value = text ? `${text}\n${line}` : line;
  el.scrollTop = el.scrollHeight;
}

function mem() {
  return new Uint8Array(wasm.memory.buffer);
}

function take(ptr, len) {
  return mem().slice(ptr, ptr + len);
}

function takeFrame() {
  return take(wasm.frame_ptr(), wasm.frame_len());
}

function cstr(ptr) {
  const bytes = mem();
  let end = ptr;
  while (bytes[end] !== 0 && end - ptr < 400) end++;
  return new TextDecoder().decode(bytes.subarray(ptr, end));
}

function showDecide() {
  const status = cstr(wasm.status_ptr());
  const param = cstr(wasm.param_ptr());
  if (status) setStatus(status);
  if (param) appendLog(paramLog, tr(param));
}

function logRx() {
  appendLog(resultLog, toHex(take(wasm.rx_ptr(), wasm.rx_len())));
}

function bump(body) {
  const step = wasm.step_get() + 1;
  wasm.step_set(step);
  appendLog(paramLog, `${pad(step)}: ${tr(body)}`);
  return step;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function failRx(error) {
  if (error && error.code === "stop") throw error;
  const why = error && error.code === "checksum" ? "checksum" : "timeout";
  bump(`RX ${why}`);
  setStatus("Error! Executing command (ret = -1)");
  const wrapped = new Error("rx");
  wrapped.code = "rx";
  throw wrapped;
}

function pushRx(bytes) {
  for (const b of bytes) rx.push(b);
  if (rxNotify) {
    const notify = rxNotify;
    rxNotify = null;
    notify();
  }
}

function readByte(deadline) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (stopFlag) {
        reject(Object.assign(new Error("stop"), { code: "stop" }));
        return;
      }
      if (rx.length) {
        resolve(rx.shift());
        return;
      }
      if (performance.now() >= deadline) {
        reject(Object.assign(new Error("timeout"), { code: "timeout" }));
        return;
      }
      rxNotify = tick;
      const wait = Math.max(1, Math.min(20, deadline - performance.now()));
      setTimeout(() => {
        if (rxNotify === tick) {
          rxNotify = null;
          tick();
        }
      }, wait);
    };
    tick();
  });
}

async function readParsed(timeoutMs, reset, feed) {
  reset();
  const deadline = performance.now() + timeoutMs;
  while (true) {
    const byte = await readByte(deadline);
    const result = feed(byte & 0xff);
    if (result === 1) return;
    if (result < 0) throw Object.assign(new Error("checksum"), { code: "checksum" });
  }
}

function readMid(timeoutMs) {
  return readParsed(timeoutMs, () => wasm.mid_parser_reset(), (b) => wasm.mid_parser_feed(b));
}

function readHostResult(timeoutMs) {
  return readParsed(timeoutMs, () => wasm.host_result_reset(), (b) => wasm.host_result_feed(b));
}

function readHostBlock(timeoutMs) {
  return readParsed(timeoutMs, () => wasm.host_data_reset(), (b) => wasm.host_data_feed(b));
}

function writeBytes(bytes) {
  const copy = Uint8Array.from(bytes);
  const run = writeChain.then(() => writer.write(copy));
  writeChain = run.then(() => {}, () => {});
  return run;
}

async function ensureReset() {
  if (!stopFlag || resetSent || !writer) return;
  resetSent = true;
  wasm.cmd_reset();
  await writeBytes(takeFrame());
  if (!running) return;
  preview();
}

function startRead() {
  reader = port.readable.getReader();
  const local = reader;
  readTask = (async () => {
    try {
      while (true) {
        const { value, done } = await local.read();
        if (done) break;
        if (value) pushRx(value);
      }
    } catch (error) {
      if (!closing) setStatus(`Serial read error: ${error.message}`);
    }
  })();
}

async function releaseIo() {
  closing = true;
  if (reader) {
    await reader.cancel().catch(() => {});
    await readTask.catch(() => {});
    try { reader.releaseLock(); } catch { /* already released */ }
    reader = null;
  }
  if (writer) {
    await writeChain.catch(() => {});
    try { writer.releaseLock(); } catch { /* already released */ }
    writer = null;
  }
  closing = false;
  rx = [];
  writeChain = Promise.resolve();
}

async function shutdownPort() {
  if (!port) return;
  await releaseIo();
  await port.close().catch(() => {});
  port = null;
}

async function setBaud(baud) {
  await releaseIo();
  await port.close();
  await port.open(serialOptions(baud));
  writer = port.writable.getWriter();
  startRead();
}

function serialOptions(baud) {
  return {
    baudRate: baud,
    dataBits: 8,
    stopBits: 1,
    parity: "none",
    flowControl: "none",
    bufferSize: 65536,
  };
}

function setConnected(open) {
  $("open").disabled = open;
  $("close").disabled = !open || running;
  $("send").disabled = !open || running;
  $("stop").disabled = !running;
  $("addPort").disabled = running;
  $("portList").disabled = open || running;
}

function portLabel(item, index) {
  const info = item.getInfo ? item.getInfo() : {};
  if (info.usbVendorId != null) {
    const hex = (value) => value.toString(16).toUpperCase().padStart(4, "0");
    return `USB ${hex(info.usbVendorId)}:${hex(info.usbProductId || 0)}`;
  }
  return `Serial ${index + 1}`;
}

async function refreshPorts(prefer) {
  const list = $("portList");
  ports = "serial" in navigator ? await navigator.serial.getPorts() : [];
  list.innerHTML = "";
  if (!ports.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = t("noPort");
    list.appendChild(option);
    return;
  }
  ports.forEach((item, index) => {
    const option = document.createElement("option");
    option.value = String(index);
    option.textContent = portLabel(item, index);
    list.appendChild(option);
  });
  if (prefer) {
    const index = ports.indexOf(prefer);
    if (index >= 0) list.value = String(index);
  }
}

function preview() {
  const cmd = selected();
  syncImageRow();
  if (!cmd || !wasm) return null;
  switch (cmd) {
    case "enrollFace": wasm.cmd_enroll_face(0, 0); break;
    case "identifyFace": wasm.cmd_verify_face(); break;
    case "deleteFace": wasm.cmd_delete_user(FACE_ID); break;
    case "clearFace": wasm.cmd_clear_face(); break;
    case "getAll": wasm.cmd_get_all_id(); break;
    case "version": wasm.cmd_get_version(); break;
    case "download": {
      const file = $("imageFile").files[0];
      wasm.cmd_download_image(file ? file.size : 0, 0);
      break;
    }
    case "cam": wasm.cmd_cam_test(CAM_W, CAM_H, CAM_ROT, CAM_SCALE); break;
    case "enrollPv": wasm.cmd_enroll_pv(0, 0); break;
    case "deletePv": wasm.cmd_delete_user(PALM_ID); break;
    case "clearPv": wasm.cmd_clear_pv(); break;
    default: return null;
  }
  const frame = takeFrame();
  cmdLog.value = toHex(frame);
  return frame;
}

function timeoutFor(cmd) {
  if (cmd === "clearFace" || cmd === "clearPv") return 8000;
  if (cmd === "enrollFace" || cmd === "enrollPv") return 10000;
  return 5000;
}

function concat(chunks, total) {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function drawGray(pixels, width, height) {
  canvas.width = width;
  canvas.height = height;
  const image = ctx.createImageData(width, height);
  const count = Math.min(pixels.length, width * height);
  for (let i = 0; i < count; i++) {
    const gray = pixels[i];
    const offset = i * 4;
    image.data[offset] = gray;
    image.data[offset + 1] = gray;
    image.data[offset + 2] = gray;
    image.data[offset + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

async function drawJpeg(bytes) {
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
}

async function runMid(cmd) {
  const frame = preview();
  rx = [];
  setStatus("Please wait while execute command...");
  await writeBytes(frame);
  const timeout = timeoutFor(cmd);
  if (LOOP.has(cmd)) {
    while (!stopFlag) {
      try {
        await readMid(timeout);
      } catch (error) {
        failRx(error);
        return;
      }
      const action = wasm.mid_decide();
      if (action === ACT_NOTE || action === ACT_OK || action === ACT_FAIL) logRx();
      showDecide();
      if (action === ACT_OK || action === ACT_FAIL) return;
    }
    return;
  }
  try {
    await readMid(timeout);
  } catch (error) {
    failRx(error);
    return;
  }
  logRx();
  wasm.mid_decide();
  showDecide();
}

async function runDownload() {
  const files = [...$("imageFile").files];
  if (!files.length) {
    setStatus("Choose a JPEG file first.");
    return;
  }
  for (const file of files) {
    if (stopFlag) return;
    wasm.cmd_download_image(file.size, 0);
    const frame = takeFrame();
    cmdLog.value = toHex(frame);
    const data = new Uint8Array(await file.arrayBuffer());
    rx = [];
    setStatus("Please wait while execute command...");
    await writeBytes(frame);
    try {
      await readMid(5000);
    } catch (error) {
      failRx(error);
      return;
    }
    logRx();
    const accept = wasm.rx_byte(1);
    if (accept !== 0) {
      if (accept === 6) setStatus("Failed DownloadImage! Turn off camera view!");
      else setStatus("Failed! DownloadImage");
      bump(`DownloadImage Error=${accept.toString(16).toUpperCase()}`);
      return;
    }
    for (let offset = 0; offset < data.length; offset += 512) {
      if (stopFlag) return;
      await writeBytes(data.subarray(offset, Math.min(offset + 512, data.length)));
    }
    try {
      await readMid(5000);
    } catch (error) {
      failRx(error);
      return;
    }
    logRx();
    if (wasm.rx_byte(1) !== 0) {
      setStatus("Failed! DownloadImage Set");
      bump(`DownloadImage Set Error=${wasm.rx_byte(1).toString(16).toUpperCase()}`);
      return;
    }
    setStatus("Ok! DownloadImage");
    bump("Ok! DownloadImage");
    try {
      await readMid(20000);
    } catch (error) {
      failRx(error);
      return;
    }
    logRx();
    if (wasm.rx_byte(0) === MID_DOWNLOAD) {
      const code = wasm.rx_byte(1);
      const id = wasm.rx_byte(3);
      if (code === 0) {
        setStatus(`OK! ID=${id} enrolled face`);
        bump(`ID=${id} enrolled face`);
      } else if (code === 10) {
        setStatus("Failed! already enrolled face");
      } else {
        setStatus("Failed! Enroll face");
      }
    }
  }
}

async function collectBlocks(timeoutMs, missesLimit) {
  const chunks = [];
  let total = 0;
  let misses = 0;
  while (!stopFlag) {
    try {
      await readHostBlock(timeoutMs);
    } catch (error) {
      if (error.code === "stop") return null;
      misses++;
      if (misses > missesLimit) throw error;
      continue;
    }
    const id = wasm.host_block_id();
    const part = take(wasm.host_block_ptr(), wasm.host_block_len());
    if (id !== 1 && id !== 8) {
      misses++;
      if (misses > missesLimit) {
        const error = new Error("unexpected");
        error.blockId = id;
        throw error;
      }
      continue;
    }
    if (total + part.length > 8 * 1024 * 1024) {
      const error = new Error("large");
      throw error;
    }
    chunks.push(part);
    total += part.length;
    if (id === 8) return concat(chunks, total);
  }
  return null;
}

async function receiveCamImage() {
  let raw;
  try {
    raw = await collectBlocks(500, 3);
  } catch (error) {
    if (error.message === "large") {
      setStatus("Error! Image is too large");
      return false;
    }
    if (error.blockId != null) {
      setStatus(`Error! Unexpected data (${error.blockId})`);
      bump(`Error! Unexpected data (${error.blockId})`);
      return false;
    }
    setStatus("Data received Error! Executing command (ret = -1)");
    bump("Data received Error! Executing command (ret = -1)");
    return false;
  }
  if (!raw) return false;
  try {
    if (raw.length >= 2 && raw[0] === 0xff && raw[1] === 0xd8) await drawJpeg(raw);
    else drawGray(raw.subarray(0, Math.min(raw.length, (wasm.cam_w() || 240) * (wasm.cam_h() || 320))), wasm.cam_w() || 240, wasm.cam_h() || 320);
  } catch {
    setStatus("JPEG decode failed");
    bump("JPEG decode failed");
    return false;
  }
  wasm.cmd_cam_note();
  const note = takeFrame();
  await writeBytes(note);
  preview();
  setStatus("Ok! LoadImage");
  bump("Ok! LoadImage");
  return true;
}

async function runCam() {
  const saved = LINK_BAUD;
  const frame = preview();
  rx = [];
  setStatus("Please wait while execute command...");
  await writeBytes(frame);
  try {
    await setBaud(CAM_BAUD);
    await sleep(100);
  } catch {
    setStatus("Could not switch the link for camera test.");
    try { await setBaud(saved); } catch { /* leave the port closed */ }
    return;
  }
  let fails = 0;
  try {
    while (!stopFlag) {
      try {
        await readMid(500);
      } catch (error) {
        if (error.code === "stop" || stopFlag) break;
        fails++;
        if (fails > 10) {
          setStatus("Error! Executing command (ret = -1)");
          break;
        }
        continue;
      }
      const action = wasm.mid_decide();
      if (action === ACT_CAM) {
        const ok = await receiveCamImage();
        if (!ok) {
          fails++;
          if (fails > 10) break;
        } else {
          fails = 0;
        }
      } else if (action === ACT_CAM_ECHO) {
        wasm.step_set(wasm.step_get() + 1);
      }
    }
  } finally {
    if (stopFlag) {
      try { await ensureReset(); } catch { /* port may already be closing */ }
    }
    try {
      await setBaud(saved);
      await sleep(100);
    } catch {
      setStatus("Could not restore the link.");
    }
  }
}

async function onSend() {
  if (!port || !writer) {
    setStatus("Open the serial port first.");
    return;
  }
  const cmd = selected();
  if (!cmd) {
    setStatus("Select a command.");
    return;
  }
  if (running) return;
  running = true;
  stopFlag = false;
  resetSent = false;
  setConnected(true);
  $("stop").disabled = false;
  $("send").disabled = true;
  $("close").disabled = true;
  try {
    if (cmd === "download") await runDownload();
    else if (cmd === "cam") await runCam();
    else await runMid(cmd);
  } catch (error) {
    if (!(error && error.code === "rx")) {
      if (stopFlag || (error && error.code === "stop")) setStatus("Stop!...");
      else setStatus(error.message || "Error! Executing command");
    }
  } finally {
    if (stopFlag) {
      try { await ensureReset(); } catch { /* ignore a closing port */ }
      if (writer) setStatus("Stop!...");
    }
    running = false;
    stopFlag = false;
    setConnected(!!port && !!writer);
  }
}

async function onOpen() {
  if (!("serial" in navigator)) {
    setStatus("Web Serial is unavailable. Open this page in Chrome or Edge.");
    return;
  }
  let chosen = ports[Number($("portList").value)];
  if (!chosen) {
    try {
      chosen = await navigator.serial.requestPort();
    } catch {
      return;
    }
    await refreshPorts(chosen);
  }
  try {
    await chosen.open(serialOptions(LINK_BAUD));
  } catch (error) {
    setStatus(`Could not open the port. ${error.message}`);
    return;
  }
  port = chosen;
  writer = port.writable.getWriter();
  writeChain = Promise.resolve();
  rx = [];
  startRead();
  setConnected(true);
  setStatus("Port open.");
}

async function onClose() {
  if (running) {
    setStatus("Stop the command before closing the port.");
    return;
  }
  await shutdownPort();
  setConnected(false);
  setStatus("Closed serial port");
}

function onStop() {
  stopFlag = true;
  setStatus("Stop!...");
}

function clearCanvas() {
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function bindUi() {
  document.querySelectorAll('input[name="cmd"]').forEach((el) => el.addEventListener("change", () => {
    if (!running) preview();
  }));
  $("pickImage").addEventListener("click", () => $("imageFile").click());
  $("imageFile").addEventListener("change", () => { if (!running) preview(); });
  $("addPort").addEventListener("click", async () => {
    if (!("serial" in navigator)) {
      setStatus("Web Serial is unavailable. Open this page in Chrome or Edge.");
      return;
    }
    try {
      const chosen = await navigator.serial.requestPort();
      await refreshPorts(chosen);
      setStatus("Port selected. Click Open.");
    } catch {
      /* user dismissed the picker */
    }
  });
  $("open").addEventListener("click", () => { onOpen(); });
  $("close").addEventListener("click", () => { onClose(); });
  $("send").addEventListener("click", () => { onSend(); });
  $("stop").addEventListener("click", onStop);
  $("clearLogs").addEventListener("click", () => {
    resultLog.value = "";
    paramLog.value = "";
    wasm.step_set(0);
  });
  $("lang").value = getLang();
  $("lang").addEventListener("change", () => {
    setLang($("lang").value);
    applyLanguage();
  });
  if ("serial" in navigator) {
    navigator.serial.addEventListener("disconnect", (event) => {
      if (event.target === port) {
        port = null;
        writer = null;
        reader = null;
        running = false;
        setConnected(false);
        setStatus("Serial device disconnected");
      }
    });
  }
}

async function boot() {
  clearCanvas();
  bindUi();
  applyLanguage();
  setConnected(false);
  try {
    const response = await fetch("protocol.wasm");
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    wasm = instance.exports;
    const code = wasm.self_test();
    wasm.step_set(0);
    if (code !== 0) throw new Error(`self-test ${code}`);
    setBoot("serial" in navigator
      ? "Ready"
      : "Open in Chrome or Edge to use the serial port.");
    document.title = "Aureon";
  } catch (error) {
    setBoot(`Protocol WASM failed: ${error.message}`);
    setStatus("Protocol module failed to load.");
  }
  if ("serial" in navigator) await refreshPorts();
}

boot();
