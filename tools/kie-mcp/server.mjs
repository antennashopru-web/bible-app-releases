#!/usr/bin/env node
// MCP server for Kie.ai (https://kie.ai): image, video and music generation.
// Zero dependencies: speaks MCP over stdio (newline-delimited JSON-RPC 2.0).
// The API key is read ONLY from the KIE_API_KEY environment variable.

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { basename, dirname, extname, resolve } from "node:path";

const API_BASE = (process.env.KIE_API_BASE || "https://api.kie.ai").replace(/\/$/, "");
const UPLOAD_BASE = (process.env.KIE_UPLOAD_BASE || "https://kieai.redpandaai.co").replace(/\/$/, "");
const SERVER_INFO = { name: "kie-ai", version: "1.0.0" };

const MODEL_HINTS = `Popular models (top-level "model" -> fields of "input"):
- google/nano-banana: text to image. input: prompt, aspect_ratio (1:1, 9:16, 16:9, 3:4, 4:3, 3:2, 2:3, 4:5, 5:4, 21:9, auto), output_format (png|jpeg).
- google/nano-banana-edit: edit images. input: prompt, image_urls [..], aspect_ratio, output_format.
- veo-3-1: video. input: prompt, model (veo3_fast|veo3_lite|veo3), generation_type (TEXT_2_VIDEO|FIRST_AND_LAST_FRAMES_2_VIDEO|REFERENCE_2_VIDEO), image_urls, aspect_ratio (16:9|9:16|Auto), resolution (720p|1080p|4k), duration (4|6|8).
- ai-music-api/generate: music (Suno). input: custom_mode (bool), instrumental (bool), model (V6|V6_MINI|V6_WILD|V5...), prompt; in custom mode also title, style, lyrics.
Other Market models (Seedream, Kling, Flux-2, Imagen 4, Sora 2, Runway...) use the same call; see https://docs.kie.ai/market/quickstart for exact names and inputs.
Local images must first be sent with kie_upload_file to get an https URL.`;

const TOOLS = [
  {
    name: "kie_credits",
    description: "Show how many Kie.ai credits are left on the account.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "kie_generate",
    description:
      "Create a Kie.ai generation task (image, video, music) and, by default, wait for the result. Returns the task state and the result file URLs (they expire in about 24 hours: save them with kie_download).\n\n" +
      MODEL_HINTS,
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: 'Model id, e.g. "google/nano-banana".' },
        input: { type: "object", description: "Model input object (prompt and model-specific fields).", additionalProperties: true },
        wait_seconds: {
          type: "integer",
          minimum: 0,
          maximum: 1800,
          description: "How long to wait for the result (default 240). 0 = return the taskId immediately; check later with kie_task_status.",
        },
        callBackUrl: { type: "string", description: "Optional webhook URL Kie.ai calls when the task finishes." },
      },
      required: ["model", "input"],
      additionalProperties: false,
    },
  },
  {
    name: "kie_task_status",
    description: "Check a Kie.ai task by taskId; optionally wait until it finishes. Returns state (waiting, queuing, generating, success, fail) and result URLs.",
    inputSchema: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        wait_seconds: { type: "integer", minimum: 0, maximum: 1800, description: "Wait up to this many seconds for completion (default 0)." },
      },
      required: ["taskId"],
      additionalProperties: false,
    },
  },
  {
    name: "kie_upload_file",
    description:
      "Upload a local file (or a public URL) to Kie.ai storage to get an https URL for image_urls / audio_urls inputs. Uploaded files are deleted after 24 hours.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to a local file." },
        url: { type: "string", description: "Public URL to copy instead of a local file." },
        file_name: { type: "string", description: "Optional file name with extension." },
      },
      additionalProperties: false,
    },
  },
  {
    name: "kie_download",
    description: "Download a generated file (from a result URL) to a local path, e.g. /mnt/project-files/kie/picture.png.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string" },
        save_to: { type: "string", description: "Local file path. If it is a folder (ends with /), the original file name is kept." },
      },
      required: ["url", "save_to"],
      additionalProperties: false,
    },
  },
  {
    name: "kie_api_request",
    description:
      "Low-level call to any Kie.ai API endpoint (for features not covered by other tools). Path like /api/v1/... on https://api.kie.ai.",
    inputSchema: {
      type: "object",
      properties: {
        method: { type: "string", enum: ["GET", "POST"] },
        path: { type: "string" },
        query: { type: "object", additionalProperties: true },
        body: { type: "object", additionalProperties: true },
      },
      required: ["method", "path"],
      additionalProperties: false,
    },
  },
];

// ---------- Kie.ai API helpers ----------

class UserError extends Error {}

function apiKey() {
  const key = (process.env.KIE_API_KEY || "").trim();
  if (!key) {
    throw new UserError(
      "KIE_API_KEY is not set. Add the Kie.ai API key as the environment variable KIE_API_KEY (never paste it into the chat). See tools/kie-mcp/README.md."
    );
  }
  return key;
}

async function kieFetch(method, url, body) {
  const headers = { Authorization: `Bearer ${apiKey()}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res;
  try {
    res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (e) {
    const host = new URL(url).host;
    throw new UserError(`Cannot reach ${host}: ${e.cause?.code || e.message}. If this runs in a cloud environment, allow the host ${host} in its network settings.`);
  }
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new UserError(`Kie.ai answered HTTP ${res.status} with non-JSON: ${text.slice(0, 300)}`);
  }
  // Kie.ai often answers HTTP 200 with an error code in the body.
  const code = json.code ?? res.status;
  if (code !== 200 || !res.ok) {
    throw new UserError(`Kie.ai error ${code}: ${json.msg || json.message || text.slice(0, 300)}${explainCode(code)}`);
  }
  return json;
}

function explainCode(code) {
  const map = {
    401: " (wrong or missing API key)",
    402: " (not enough credits)",
    422: " (invalid parameters: check model name and input fields)",
    429: " (rate limit: max 20 new tasks per 10 seconds)",
    455: " (service maintenance)",
    505: " (feature disabled)",
  };
  return map[code] || "";
}

function apiUrl(path, query) {
  const u = new URL(path.startsWith("/") ? path : `/${path}`, API_BASE + "/");
  for (const [k, v] of Object.entries(query || {})) u.searchParams.set(k, String(v));
  return u.toString();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseMaybeJson(v) {
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function collectUrls(value, out = new Set()) {
  if (typeof value === "string") {
    const parsed = parseMaybeJson(value);
    if (parsed !== value) return collectUrls(parsed, out);
    if (/^https?:\/\//.test(value)) out.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectUrls(v, out));
  } else if (value && typeof value === "object") {
    Object.values(value).forEach((v) => collectUrls(v, out));
  }
  return out;
}

function summarizeTask(data) {
  const result = parseMaybeJson(data.resultJson);
  const urls = result ? [...collectUrls(result)] : [];
  // Suno-style responses keep tracks under data.response
  if (!urls.length && data.response) urls.push(...collectUrls(data.response));
  const summary = {
    taskId: data.taskId,
    model: data.model,
    state: data.state,
    result_urls: urls,
  };
  if (data.state === "fail") {
    summary.failCode = data.failCode;
    summary.failMsg = data.failMsg;
  }
  if (data.progress !== undefined && data.progress !== null) summary.progress = data.progress;
  if (data.creditsConsumed !== undefined) summary.creditsConsumed = data.creditsConsumed;
  if (data.costTime) summary.seconds = Math.round(data.costTime / 1000);
  if (result && typeof result === "object" && result.resultObject) summary.resultObject = result.resultObject;
  return summary;
}

async function getTask(taskId) {
  const json = await kieFetch("GET", apiUrl("/api/v1/jobs/recordInfo", { taskId }));
  return json.data || {};
}

async function waitTask(taskId, waitSeconds) {
  const deadline = Date.now() + waitSeconds * 1000;
  let delay = 3000;
  let data = await getTask(taskId);
  while (!["success", "fail"].includes(data.state) && Date.now() + delay < deadline) {
    await sleep(delay);
    delay = Math.min(delay * 1.5, 15000);
    data = await getTask(taskId);
  }
  const summary = summarizeTask(data);
  if (!["success", "fail"].includes(data.state)) {
    summary.note = `Still running. Call kie_task_status with taskId ${taskId} later.`;
  } else if (data.state === "success") {
    summary.note = "Result links expire in about 24 hours: save what you need with kie_download.";
  }
  return summary;
}

// ---------- tool handlers ----------

const handlers = {
  async kie_credits() {
    const json = await kieFetch("GET", apiUrl("/api/v1/chat/credit"));
    return { credits: json.data };
  },

  async kie_generate({ model, input, wait_seconds = 240, callBackUrl }) {
    if (!model || typeof input !== "object") throw new UserError("model and input are required.");
    const body = { model, input };
    if (callBackUrl) body.callBackUrl = callBackUrl;
    const json = await kieFetch("POST", apiUrl("/api/v1/jobs/createTask"), body);
    const taskId = json.data?.taskId;
    if (!taskId) throw new UserError(`No taskId in answer: ${JSON.stringify(json).slice(0, 300)}`);
    if (!wait_seconds) return { taskId, state: "created", note: "Check with kie_task_status." };
    return waitTask(taskId, wait_seconds);
  },

  async kie_task_status({ taskId, wait_seconds = 0 }) {
    if (!taskId) throw new UserError("taskId is required.");
    if (wait_seconds > 0) return waitTask(taskId, wait_seconds);
    return summarizeTask(await getTask(taskId));
  },

  async kie_upload_file({ file_path, url, file_name }) {
    if (!file_path === !url) throw new UserError("Give exactly one of file_path or url.");
    const uploadPath = "mcp-uploads";
    let json;
    if (url) {
      json = await kieFetch("POST", `${UPLOAD_BASE}/api/file-url-upload`, {
        fileUrl: url,
        uploadPath,
        ...(file_name ? { fileName: file_name } : {}),
      });
    } else {
      const buf = await readFile(resolve(file_path));
      json = await kieFetch("POST", `${UPLOAD_BASE}/api/file-base64-upload`, {
        base64Data: buf.toString("base64"),
        uploadPath,
        fileName: file_name || basename(file_path),
      });
    }
    const d = json.data || {};
    return { url: d.downloadUrl || d.fileUrl, fileName: d.fileName, size: d.fileSize, mimeType: d.mimeType, note: "Deleted after 24 hours." };
  },

  async kie_download({ url, save_to }) {
    let target = save_to;
    if (save_to.endsWith("/")) {
      const name = basename(new URL(url).pathname) || `kie-${Date.now()}`;
      target = save_to + name;
    }
    target = resolve(target);
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new UserError(`Cannot reach ${new URL(url).host}: ${e.cause?.code || e.message}. Allow this host in the network settings.`);
    }
    if (!res.ok) {
      // Kie.ai can turn its own result links into fresh download links.
      try {
        const j = await kieFetch("POST", apiUrl("/api/v1/common/download-url"), { url });
        res = await fetch(j.data);
      } catch {
        /* keep original response */
      }
    }
    if (!res.ok) throw new UserError(`Download failed: HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!extname(target)) {
      const type = res.headers.get("content-type") || "";
      const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp", "video/mp4": ".mp4", "audio/mpeg": ".mp3", "audio/wav": ".wav" }[type.split(";")[0]];
      if (ext) target += ext;
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, buf);
    return { saved_to: target, bytes: buf.length };
  },

  async kie_api_request({ method, path, query, body }) {
    if (!path.startsWith("/api/")) throw new UserError("path must start with /api/");
    return kieFetch(method, apiUrl(path, query), method === "POST" ? body || {} : undefined);
  },
};

// ---------- MCP stdio transport ----------

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function redact(text) {
  const key = process.env.KIE_API_KEY;
  return key && key.length > 4 ? text.split(key).join("***") : text;
}

async function handle(msg) {
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;
  try {
    let result;
    switch (method) {
      case "initialize":
        result = {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
          instructions:
            "Kie.ai generation tools. Typical flow: kie_generate (waits for the result) -> kie_download to save the file. Check balance with kie_credits. Generations spend the user's credits: do not repeat a call just to retry.",
        };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const name = params?.name;
        const fn = handlers[name];
        if (!fn) throw Object.assign(new Error(`Unknown tool: ${name}`), { rpcCode: -32602 });
        try {
          const out = await fn(params?.arguments || {});
          result = { content: [{ type: "text", text: redact(JSON.stringify(out, null, 2)) }] };
        } catch (e) {
          const text = e instanceof UserError ? e.message : `Unexpected error: ${e.stack || e.message}`;
          result = { content: [{ type: "text", text: redact(text) }], isError: true };
        }
        break;
      }
      default:
        if (!isRequest) return; // notifications such as notifications/initialized
        throw Object.assign(new Error(`Method not found: ${method}`), { rpcCode: -32601 });
    }
    if (isRequest) send({ jsonrpc: "2.0", id, result });
  } catch (e) {
    if (isRequest) send({ jsonrpc: "2.0", id, error: { code: e.rpcCode || -32603, message: redact(e.message) } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    for (const m of Array.isArray(msg) ? msg : [msg]) handle(m);
  }
});
