import { n as imageGenLanguageOf, r as interpolate } from "./locale-tables-CmfCws9z.js";
import { existsSync, promises, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as settingsModule from "@deepseek-ai/dsh-settings";
import { SettingsConflictError } from "@deepseek-ai/dsh-settings";
import z from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import http from "node:http";
import { inflateRawSync, inflateSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { defineTool } from "@deepseek-ai/dsh-tools";
//#region src/settings-compat.ts
const compatModule = settingsModule;
/** Strip volatile markers for the pre-0.1.7 settings providers. */
function plainSettingsSchema(schema) {
	const clone = schema.toJSON();
	const seen = /* @__PURE__ */ new WeakSet();
	const walk = (node) => {
		if (typeof node !== "object" || node === null || seen.has(node)) return;
		seen.add(node);
		const record = node;
		const meta = record.meta;
		if (typeof meta === "object" && meta !== null) delete meta.volatile;
		if (typeof record.dict === "object" && record.dict !== null) for (const child of Object.values(record.dict)) walk(child);
		walk(record.inner);
		walk(record.sKey);
		if (Array.isArray(record.list)) for (const child of record.list) walk(child);
	};
	walk(clone);
	return clone;
}
/** The loader entry id of the plugin instance owning `ctx`, when available. */
function entryNamespaceOf(ctx) {
	const compat = ctx;
	const entry = compat.fiber?.entry;
	const candidates = [
		entry?.options?.id,
		entry?.id,
		compat.loader?.locate?.(compat.fiber)
	];
	for (const candidate of candidates) if (typeof candidate === "string" && candidate !== "") return candidate;
}
/** Brand namespaces where the installed settings package still exposes it. */
function settingsNamespaceCompat(value) {
	return compatModule.settingsNamespace?.(value) ?? value;
}
/**
* Resolve the namespace the settings bridge must read and write.
*
* Older settings providers register a caller-chosen namespace through the
* module helper or `provider.installSection`. The managed-forms provider used
* by DSH 0.1.7 derives forms from the plugin's profile entry instead, so its
* namespace is the entry id (`imagegen`) rather than the legacy display id
* (`dsh-imagegen`). The bridge keeps the legacy id on its public wire contract
* and translates it to this internal namespace.
*/
function resolveSettingsNamespaceCompat(ctx, provider, fallback) {
	const candidate = provider;
	if (candidate.configure !== void 0 && candidate.installSection === void 0) {
		const fromEntry = entryNamespaceOf(ctx);
		return fromEntry === "imagegen" ? fromEntry : "imagegen";
	}
	if (compatModule.installSettingsSection !== void 0) return fallback;
	if (candidate.installSection !== void 0) return fallback;
	return fallback;
}
/**
* Register an optional settings section across the rc.7, alpha.2 and managed
* forms APIs. The first two expose an installer; 0.1.7 derives forms directly
* from the plugin's volatile Config and only needs the custom-page policy.
*/
function installSettingsSectionCompat(ctx, ns, schema, entry, hooks) {
	const legacyInstaller = compatModule.installSettingsSection;
	if (legacyInstaller !== void 0) {
		legacyInstaller(ctx, ns, plainSettingsSchema(schema), entry, hooks);
		return;
	}
	ctx.inject(["settings"], (sctx) => {
		const provider = sctx.get("settings");
		if (provider.installSection !== void 0) {
			provider.installSection(ctx, ns, plainSettingsSchema(schema), entry, hooks);
			return;
		}
		if (provider.configure === void 0) throw new TypeError("dsh-settings does not expose installSection or configure");
		sctx.effect(() => {
			const dispose = provider.configure?.({ auto: false }, ctx.fiber);
			return typeof dispose === "function" ? dispose : () => {};
		});
		const namespace = entryNamespaceOf(ctx);
		if (namespace !== void 0) {
			const settingsEvents = sctx;
			sctx.effect(() => settingsEvents.on("settings/document-updated", (updated) => {
				if (String(updated) === namespace) hooks.onChange();
			}));
		}
	});
}
//#endregion
//#region src/protocol.ts
/**
* Wire contract shared by the host and client halves of dsh-imagegen: the
* settings namespace, the route paths, and the generate payload/result shapes.
* Pure types + constants 鈥?safe for the client bundle to inline.
*/
/** Settings namespace this plugin owns (host settings seam + bridge). */
const IMAGEGEN_SETTINGS_NAMESPACE = "dsh-imagegen";
/** Published package version shared by the host updater and the client UI. */
const PLUGIN_VERSION = "1.6.9";
/** Same-origin route family (loopback-only, mirroring the dsh-ssh fence). */
const SETTINGS_API = {
	describe: "/api/dsh-imagegen/settings/describe",
	mutate: "/api/dsh-imagegen/settings/mutate"
};
/** Subscription account login and status routes. */
const SUBSCRIPTION_API = {
	status: "/api/dsh-imagegen/subscription/status",
	login: "/api/dsh-imagegen/subscription/login"
};
/** Official/subscription-backed image providers. */
const SUBSCRIPTION_PROVIDERS = [
	"chatgpt-sub",
	"grok-sub",
	"google-sub",
	"openrouter-sub"
];
/** Whether an endpoint URL explicitly names an OpenAI-compatible chat route. */
function isChatCompletionsUrl(value) {
	const trimmed = value.trim();
	if (trimmed === "") return false;
	try {
		return /\/chat\/completions\/?$/.test(new URL(trimmed).pathname);
	} catch {
		return /\/chat\/completions\/?$/.test(trimmed.split(/[?#]/, 1)[0] ?? "");
	}
}
/** Whether a stored value is one of the accepted protocol preferences. */
function isChannelProtocolPreference(value) {
	return value === "auto" || value === "images" || value === "chat-completions";
}
/** Resolve a channel preference without changing legacy behavior by default. */
function resolveChannelProtocol(apiUrl, preference = "auto") {
	if (preference === "images" || preference === "chat-completions") return preference;
	return isChatCompletionsUrl(apiUrl) ? "chat-completions" : "images";
}
/** Subscription channels with a fixed image model. */
const DEFAULT_SUBSCRIPTION_MODELS = {
	"chatgpt-sub": "gpt-image-2.5-flare",
	"grok-sub": "grok-imagine-image-2.0",
	"google-sub": "gemini-3-pro-image",
	"openrouter-sub": "google/gemini-3-pro-image"
};
/** Human-facing provider names used in status and errors. */
const SUBSCRIPTION_PROVIDER_DISPLAY_NAMES = {
	"chatgpt-sub": "ChatGPT 订阅",
	"grok-sub": "Grok 订阅",
	"google-sub": "Google 订阅",
	"openrouter-sub": "OpenRouter 账号"
};
/** Whether a raw string names one of the subscription providers. */
function isSubscriptionProvider(value) {
	return typeof value === "string" && SUBSCRIPTION_PROVIDERS.includes(value);
}
/** The image-generation proxy route. */
const GENERATE_API = "/api/dsh-imagegen/generate";
/** Host-mediated OpenAI-compatible prompt enhancement endpoints. */
const PROMPT_ENHANCE_API = {
	models: "/api/dsh-imagegen/prompt-enhance/models",
	enhance: "/api/dsh-imagegen/prompt-enhance"
};
/** Host-mediated candidate discovery for the configured image API. */
const IMAGE_MODEL_API = { models: "/api/dsh-imagegen/image-models" };
/** Host-served built-in provider catalog (channels the user can instantiate). */
const PRESETS_API = "/api/dsh-imagegen/presets";
/** Loopback-only image reader for Agent tool-result previews. */
const AGENT_IMAGE_API = "/api/dsh-imagegen/agent-image";
/** Store the current composer image for the direct edit_image command. */
const CONVERSATION_IMAGE_API = "/api/dsh-imagegen/conversation-image";
/**
* Host-computed per-channel usage counters (generation-count badges in the
* settings card): entries are tallied from the persisted history and gallery
* by channel + model alias.
*/
const USAGE_API = "/api/dsh-imagegen/usage";
/** Host-resident generation queue endpoints. */
const TASK_API = {
	submit: "/api/dsh-imagegen/tasks/submit",
	list: "/api/dsh-imagegen/tasks/list",
	get: "/api/dsh-imagegen/tasks/get",
	cancel: "/api/dsh-imagegen/tasks/cancel",
	retry: "/api/dsh-imagegen/tasks/retry"
};
/** Reveal the host data directory (saved images) in the OS file manager. */
const DATA_FOLDER_API = "/api/dsh-imagegen/data-folder/open";
/**
* Generation diagnostics (#38): the retained record of upstream attempts, so a
* failure can be explained after the fact instead of only being toasted once.
*/
const DIAGNOSTICS_API = {
	list: "/api/dsh-imagegen/diagnostics/list",
	clear: "/api/dsh-imagegen/diagnostics/clear"
};
/** Probe the configured S3-compatible object storage. */
const STORAGE_API = { test: "/api/dsh-imagegen/storage/test" };
/** Host-mediated GitHub Release update routes. */
const UPDATE_API = {
	check: "/api/dsh-imagegen/update/check",
	apply: "/api/dsh-imagegen/update/apply"
};
/**
* Same-origin route family for the host-persisted generation history. Images
* live as files under ~/.dsh/dsh-imagegen/images/ and are served back through
* the `image` prefix route, so list responses carry metadata only (never
* base64) and the browser loads thumbnails/previews lazily.
*/
const HISTORY_API = {
	list: "/api/dsh-imagegen/history/list",
	append: "/api/dsh-imagegen/history/append",
	remove: "/api/dsh-imagegen/history/remove",
	clear: "/api/dsh-imagegen/history/clear",
	image: "/api/dsh-imagegen/history/image"
};
/**
* Same-origin route family for the user-curated gallery (favorites). Entries
* reuse the history wire shape and persist under ~/.dsh/dsh-imagegen/gallery/;
* unlike history there is no size cap 鈥?the user adds images on purpose.
*/
const GALLERY_API = {
	list: "/api/dsh-imagegen/gallery/list",
	append: "/api/dsh-imagegen/gallery/append",
	remove: "/api/dsh-imagegen/gallery/remove",
	clear: "/api/dsh-imagegen/gallery/clear",
	tags: "/api/dsh-imagegen/gallery/tags",
	image: "/api/dsh-imagegen/gallery/image"
};
/** Host-persisted infinite canvas projects and their content-addressed assets. */
const CANVAS_API = {
	list: "/api/dsh-imagegen/canvas/list",
	create: "/api/dsh-imagegen/canvas/create",
	read: "/api/dsh-imagegen/canvas/read",
	save: "/api/dsh-imagegen/canvas/save",
	remove: "/api/dsh-imagegen/canvas/remove",
	favorite: "/api/dsh-imagegen/canvas/favorite",
	assetUpload: "/api/dsh-imagegen/canvas/asset/upload",
	assetImport: "/api/dsh-imagegen/canvas/asset/import",
	asset: "/api/dsh-imagegen/canvas/asset",
	/** Vision-model layer decomposition for the canvas layer-split tool. */
	layers: "/api/dsh-imagegen/canvas/layers",
	/** Raw-binary upload for arbitrary canvas file nodes (no base64 inflation). */
	fileUpload: "/api/dsh-imagegen/canvas/file/upload",
	/** Structured content preview (text / table / office / archive) of one asset. */
	filePreview: "/api/dsh-imagegen/canvas/file/preview"
};
/** Same-origin route family for canvas skills (catalog + run control). */
const CANVAS_SKILL_API = {
	list: "/api/dsh-imagegen/canvas/skills/list",
	run: "/api/dsh-imagegen/canvas/skills/run",
	task: "/api/dsh-imagegen/canvas/skills/task",
	cancel: "/api/dsh-imagegen/canvas/skills/cancel",
	/** Local skill library (`~/.dsh/skills`): inspect, install, remove. */
	library: "/api/dsh-imagegen/canvas/skills/library",
	install: "/api/dsh-imagegen/canvas/skills/install",
	remove: "/api/dsh-imagegen/canvas/skills/remove",
	/** Per-skill configuration values declared by `skill.config.json` (or a recipe). */
	configSave: "/api/dsh-imagegen/canvas/skills/config/save",
	/** Run a declaration's `apply` steps (commands / files) with the saved values. */
	configApply: "/api/dsh-imagegen/canvas/skills/config/apply"
};
/**
* Same-origin route family for the prompt-template libraries. The library is
* multi-source: every request names a source id from {@link TEMPLATE_SOURCES},
* each source keeps an independent snapshot/image cache host-side, and
* reference images are proxied through the source-scoped `image` prefix route
* (`…/image/<sourceId>/<file>`) and cached on disk so repeated views never hit
* the network again.
*/
const TEMPLATES_API = {
	list: "/api/dsh-imagegen/templates/list",
	refresh: "/api/dsh-imagegen/templates/refresh",
	sample: "/api/dsh-imagegen/templates/sample",
	image: "/api/dsh-imagegen/templates/image"
};
/** Same-origin route family for the user's saved (favorited) templates. */
const TEMPLATE_FAVORITES_API = {
	list: "/api/dsh-imagegen/templates/favorites/list",
	add: "/api/dsh-imagegen/templates/favorites/add",
	remove: "/api/dsh-imagegen/templates/favorites/remove"
};
/**
* The template-library source registry. Each entry is fully independent (own
* upstream JSON, own image pool, own refresh state) and renders as its own
* tab; adding a source later means appending an entry here plus a host-side
* fetch definition in templates-store.ts and an optional bundled snapshot.
*/
const TEMPLATE_SOURCES = [
	{
		id: "vibeui",
		label: "精选案例库",
		homepage: "https://vibeui.top/",
		description: "awesome-gpt-image-2 精选提示词案例（vibeui.top 镜像）"
	},
	{
		id: "canghe",
		label: "沧河案例库",
		homepage: "https://gpt-image2.canghe.ai/",
		description: "GPT-Image2 Prompt Gallery（gpt-image2.canghe.ai，定期更新）"
	},
	{
		id: "handraw",
		label: "手绘模板库",
		homepage: "https://github.com/yang0/handraw-style",
		description: "手绘风格、排版图型与主题色图鉴（yang0/handraw-style）",
		refreshable: false
	},
	{
		id: "prompt-signal",
		label: "Prompt/Signal",
		homepage: "https://github.com/andy7076/image_prompt",
		description: "andy7076/image_prompt 的 570+ 精选生图提示词",
		refreshable: false
	},
	{
		id: "evolink",
		label: "GPT Image 2 案例库",
		homepage: "https://github.com/EvoLinkAI/awesome-gpt-image-2-prompts",
		description: "EvoLink 整理的 GPT Image 2 电商、广告、人像、海报、角色与 UI 案例",
		refreshable: false
	}
];
/** Default source id when a request does not name one (legacy clients). */
const DEFAULT_TEMPLATE_SOURCE_ID = TEMPLATE_SOURCES[0].id;
/** True when the id names a registered template source. */
function isTemplateSourceId(id) {
	return TEMPLATE_SOURCES.some((source) => source.id === id);
}
//#endregion
//#region src/model-catalog.ts
const ENTRIES = {
	"gpt-image": {
		label: "gpt-image",
		labelZh: "GPT 图像",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: false,
		qualityTiers: [
			"1K",
			"2K",
			"4K"
		]
	},
	"dall-e": {
		label: "DALL·E",
		labelZh: "DALL·E",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: false,
		qualityTiers: ["auto"]
	},
	grok: {
		label: "grok",
		labelZh: "Grok",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: true,
		qualityTiers: ["1K", "2K"]
	},
	nanobanana: {
		label: "nanobanana",
		labelZh: "Nano Banana",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: true,
		qualityTiers: [
			"1K",
			"2K",
			"4K"
		]
	},
	seedream: {
		label: "seedream",
		labelZh: "Seedream",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: true,
		qualityTiers: ["1K", "2K"]
	},
	zhipu: {
		label: "GLM-Image",
		labelZh: "智谱图像",
		known: true,
		supportsEdit: false,
		supportsAspectRatio: false,
		qualityTiers: ["HD"]
	},
	qwen: {
		label: "qwen-image",
		labelZh: "千问图像",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: true,
		qualityTiers: ["auto"]
	},
	minimax: {
		label: "MiniMax",
		labelZh: "MiniMax 图像",
		known: true,
		supportsEdit: true,
		supportsAspectRatio: true,
		qualityTiers: ["auto"]
	}
};
/** Documented upstream prompt hard limits (UTF-16 code units). The engine
*  fast-fails on these before any network call and the panel counter shows
*  them live; families absent here have no documented limit. */
const PROMPT_CHAR_LIMITS = { minimax: 1500 };
/** The documented prompt character limit for a model id, or null when the
*  family has no known limit. Single source of truth for engine enforcement
*  and the panel's live counter. */
function promptCharLimit(model) {
	const { family } = describeModel(model);
	return (family !== "unknown" ? PROMPT_CHAR_LIMITS[family] : void 0) ?? null;
}
/** Official Gemini image ids served by Nano Banana gateways. */
const NANOBANANA_GEMINI_IDS = /* @__PURE__ */ new Set([
	"gemini-3-pro-image",
	"gemini-3-pro-image-preview",
	"gemini-3.1-flash-image",
	"gemini-3.1-flash-image-preview",
	"gemini-3.1-flash-lite-image",
	"gemini-2.5-flash-image"
]);
/** Classify one upstream model id into its request-shaping family. */
function describeModel(model) {
	const id = model.trim();
	if (/^gpt-image/i.test(id)) return {
		family: "gpt-image",
		...ENTRIES["gpt-image"]
	};
	if (/^dall-e/i.test(id)) return {
		family: "dall-e",
		...ENTRIES["dall-e"]
	};
	if (/^grok-imagine(?:-|$)/.test(id)) return {
		family: "grok",
		...ENTRIES.grok
	};
	if (/^nanobanana/i.test(id) || NANOBANANA_GEMINI_IDS.has(id)) return {
		family: "nanobanana",
		...ENTRIES.nanobanana
	};
	if (/^(?:doubao-)?seedream/i.test(id)) return {
		family: "seedream",
		...ENTRIES.seedream
	};
	if (/^(?:glm-image|cogview(?:-|$))/i.test(id)) return {
		family: "zhipu",
		...ENTRIES.zhipu
	};
	if (/^qwen-image(?:[-_.]|$)/i.test(id)) return {
		family: "qwen",
		...ENTRIES.qwen
	};
	if (/^(?:minimax[-_/])?image-\d+/i.test(id)) return {
		family: "minimax",
		...ENTRIES.minimax
	};
	return {
		family: "unknown",
		label: "unknown",
		labelZh: "未知协议",
		known: false,
		supportsEdit: true,
		supportsAspectRatio: false,
		qualityTiers: []
	};
}
/** Conservative fallback for providers whose /models response only has ids.
*  Metadata-aware filtering lives in prompt-enhancer.ts; this catches common
*  image model naming conventions without treating every unknown model as an
*  image model. */
function isLikelyImageModelId(model) {
	return /(?:^|[-_.])(?:image|img|diffusion|flux|cogview|imagen|seedream|nanobanana|grok-imagine|dall-e|stable-diffusion|sdxl|pixart|kolors|ideogram|midjourney|recraft|hunyuan|jimeng|wanx|hidream|playground)(?:$|[-_.])/i.test(model.trim());
}
/** The family a model id routes its request through. */
function modelFamily(model) {
	return describeModel(model).family;
}
//#endregion
//#region src/prompt-enhancer.ts
/** OpenAI-compatible chat helpers used by the optional prompt-enhancement UI. */
function endpoint(base, suffix) {
	return `${base.replace(/\/+$/, "")}${suffix}`;
}
function headers(apiKey) {
	return {
		"content-type": "application/json",
		...apiKey.trim() === "" ? {} : { authorization: `Bearer ${apiKey.trim()}` }
	};
}
async function responseJson(response) {
	const body = await response.json().catch(() => void 0);
	if (!response.ok || body === void 0 || body === null || typeof body !== "object") {
		const message = body !== null && typeof body === "object" && typeof body.error?.message === "string" ? body.error.message : `HTTP ${response.status}`;
		throw new Error(message);
	}
	return body;
}
/** Candidate /models URLs for a configured base URL, most specific first. */
function modelListUrls(config) {
	const base = config.apiUrl.trim().replace(/\/+$/, "");
	if (base === "") throw new Error("API URL is required");
	const urls = [];
	if (resolveChannelProtocol(base, config.protocol) === "chat-completions" && isChatCompletionsUrl(base)) {
		const url = new URL(base);
		url.pathname = `${url.pathname.replace(/\/chat\/completions\/?$/, "")}/models`;
		url.search = "";
		url.hash = "";
		urls.push(url.toString());
		return urls;
	}
	urls.push(endpoint(base, "/models"));
	try {
		const url = new URL(base);
		const path = url.pathname.replace(/\/+$/, "");
		if (!/\/v\d+(?:[a-z0-9._-]*)?$/i.test(path)) {
			url.pathname = `${path === "" || path === "/" ? "" : path}/v1/models`;
			url.search = "";
			url.hash = "";
			urls.push(url.toString());
		}
	} catch {}
	return [...new Set(urls)];
}
function errorMessageOf(body, fallback) {
	if (body === null || typeof body !== "object") return fallback;
	const record = body;
	const error = record.error;
	if (error !== null && typeof error === "object" && typeof error.message === "string") return error.message;
	return typeof record.message === "string" && record.message.trim() !== "" ? record.message : fallback;
}
function modelRecordsOf(body) {
	const candidate = Array.isArray(body) ? body : body !== null && typeof body === "object" && Array.isArray(body.data) ? body.data : body !== null && typeof body === "object" && Array.isArray(body.models) ? body.models : void 0;
	if (candidate === void 0) return void 0;
	return candidate.flatMap((item) => {
		const id = typeof item === "string" ? item.trim() : item !== null && typeof item === "object" && typeof item.id === "string" ? item.id.trim() : "";
		return id === "" ? [] : [{
			...typeof item === "object" && item !== null ? item : {},
			id
		}];
	});
}
async function fetchModelRecords(url, apiKey) {
	const response = await fetch(url, { headers: headers(apiKey) });
	const text = await response.text().catch(() => "");
	let body;
	try {
		body = text.trim() === "" ? void 0 : JSON.parse(text);
	} catch {
		body = void 0;
	}
	if (!response.ok) {
		const fallback = `HTTP ${response.status}`;
		return {
			error: new Error(errorMessageOf(body, fallback)),
			retryable: response.status === 404 || response.status === 405
		};
	}
	if (body === void 0) {
		const type = response.headers.get("content-type") ?? "unknown content-type";
		const sample = text.replace(/\s+/g, " ").trim().slice(0, 160);
		return {
			error: /* @__PURE__ */ new Error(`模型接口返回了非 JSON 响应（HTTP ${response.status}, ${type}）${sample === "" ? "" : `：${sample}`}`),
			retryable: true
		};
	}
	const records = modelRecordsOf(body);
	if (records === void 0) return {
		error: new Error(errorMessageOf(body, "模型接口响应中没有 data/models 列表")),
		retryable: true
	};
	return {
		records,
		retryable: false
	};
}
async function listModelRecords(config) {
	const urls = modelListUrls(config);
	let lastError;
	for (const url of urls) {
		let attempt;
		try {
			attempt = await fetchModelRecords(url, config.apiKey);
		} catch (error) {
			lastError = error instanceof Error ? error : new Error(String(error));
			continue;
		}
		if (attempt.records !== void 0) return attempt.records;
		lastError = attempt.error;
		if (!attempt.retryable) throw attempt.error;
	}
	throw lastError ?? /* @__PURE__ */ new Error("模型接口不可用");
}
function textOf(value) {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.filter((item) => typeof item === "string");
}
function hasImageGenerationCapability(record) {
	const capability = record.capabilities;
	if (capability !== null && typeof capability === "object") {
		const values = capability;
		for (const key of [
			"image_generation",
			"imageGeneration",
			"text_to_image",
			"textToImage",
			"image_gen"
		]) if (typeof values[key] === "boolean") return values[key];
		const serialized = JSON.stringify(values).toLowerCase();
		if (/image[ _-]?generation|text[ _-]?to[ _-]?image/.test(serialized)) return true;
	}
	const taskText = [
		...textOf(record.task),
		...textOf(record.task_type),
		...textOf(record.taskType),
		...textOf(record.type),
		...textOf(record.model_type),
		...textOf(record.modelType),
		...textOf(record.tasks),
		...textOf(record.description)
	].join(" ").toLowerCase();
	if (/image[ _-]?generation|text[ _-]?to[ _-]?image|image[ _-]?gen/.test(taskText)) return true;
	if (/^image(?:[ _-]?generation)?$/.test(taskText.trim())) return true;
	if (/embedding|rerank|moderation|transcri|speech|audio|video|chat[ _-]?completion/.test(taskText)) return false;
	for (const key of [
		"output_modalities",
		"outputModalities",
		"supported_output_modalities"
	]) {
		const modalities = textOf(record[key]).map((value) => value.toLowerCase());
		if (modalities.length > 0) return modalities.includes("image");
	}
}
function isImageModelRecord(record) {
	return hasImageGenerationCapability(record) ?? isLikelyImageModelId(record.id);
}
/** List candidates exposed by an OpenAI-compatible endpoint. */
async function listOpenAIModels(config) {
	return [...new Set((await listModelRecords(config)).map((record) => record.id))].sort((a, b) => a.localeCompare(b));
}
/** List only models that advertise or conventionally represent image generation. */
async function listImageModels(config) {
	return [...new Set((await listModelRecords(config)).filter(isImageModelRecord).map((record) => record.id))].sort((a, b) => a.localeCompare(b));
}
/** List chat models exposed by an OpenAI-compatible endpoint. */
async function listPromptModels(config) {
	return listOpenAIModels(config);
}
/** Remove reasoning-model artifacts from a chat model's visible content:
*  complete `<think>…</think>` blocks first, then anything from a dangling
*  unclosed `<think>` to the end of the text. Reasoning models served through
*  OpenAI-compatible endpoints (MiniMax M3, DeepSeek R1, Qwen QVQ, …) inline
*  these blocks in `message.content`; leaking them into the prompt box both
*  pollutes the prompt and can push it past image models' length limits. */
function stripReasoning(text) {
	const withoutClosed = text.replace(/<think>[\s\S]*?<\/think>/gi, "");
	const dangling = /<think>/i.exec(withoutClosed);
	return (dangling === null ? withoutClosed : withoutClosed.slice(0, dangling.index)).trim();
}
/**
* Run one chat completion and return the cleaned visible answer.
*
* Shared by prompt enhancement, the canvas light-tier skill runner and the
* layer analyzer: it owns the endpoint, auth, error shaping (an upstream
* `error.message` is surfaced verbatim) and the reasoning-strip step, so every
* caller sees the same behaviour.
* @param config - endpoint, secret and model.
* @param options - prompt parts plus optional sampling controls.
* @returns the model's visible answer, with reasoning artifacts removed.
*/
async function chatComplete(config, options) {
	if (config.apiUrl.trim() === "" || config.model.trim() === "") throw new Error("chat model is not configured (left sidebar > Image settings > Prompt enhancement)");
	const body = await responseJson(await fetch(endpoint(config.apiUrl, "/chat/completions"), {
		method: "POST",
		headers: headers(config.apiKey),
		body: JSON.stringify({
			model: config.model.trim(),
			temperature: options.temperature ?? .4,
			...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
			messages: [{
				role: "system",
				content: options.system
			}, {
				role: "user",
				content: typeof options.content === "string" ? options.content : options.content
			}]
		}),
		...options.signal === void 0 ? {} : { signal: options.signal }
	}));
	const choices = Array.isArray(body.choices) ? body.choices : [];
	const content = choices[0] !== null && typeof choices[0] === "object" ? choices[0].message?.content : void 0;
	if (typeof content !== "string" || content.trim() === "") throw new Error("chat model returned an empty answer");
	const answer = stripReasoning(content);
	if (answer === "") throw new Error("chat model returned only reasoning content (empty <think> payload)");
	return answer;
}
/** Expand a concise image request into a production-ready image prompt. */
async function enhancePrompt(config, prompt) {
	return chatComplete(config, {
		temperature: .7,
		system: "You are an expert image-prompt editor. Expand the user request into one vivid, specific image-generation prompt. Preserve intent and language. Add only useful visual detail: subject, composition, lighting, materials, color, camera/style and quality. Return only the finished prompt, with no preface or markdown.",
		content: prompt
	});
}
/** Polish one existing generation prompt without changing its purpose. */
async function polishPrompt(config, prompt) {
	return chatComplete(config, {
		temperature: .35,
		system: "你是电商生图提示词编辑。请在保持图片用途、商品事实、平台、语言和原有结构不变的前提下，润色文字并补充可执行的视觉细节，减少重复和空泛表达。只输出最终提示词，不要解释、标题或 Markdown。",
		content: prompt
	});
}
//#endregion
//#region src/layer-analyzer.ts
/**
* Canvas layer decomposition (the 图层拆分 / magic-layers tool).
*
* The host asks the configured *chat* model — the same OpenAI-compatible
* endpoint the prompt enhancer uses — to read the picture and answer with a
* strict JSON layer plan (background / object / text). The browser half then
* rasterizes that plan into real canvas nodes: text layers become editable text
* nodes, object layers are cropped and locally matted into transparent PNGs,
* and the background layer reuses the source asset.
*
* Nothing here is trusted: the model output is normalized, clamped and
* length-capped before it reaches the client.
*/
/** Cap on the image payload accepted for analysis (base64 data URL). */
const MAX_LAYER_IMAGE_BYTES = 12 * 1024 * 1024;
/** Hard cap on layers, so a chatty model cannot flood the canvas. */
const MAX_LAYERS = 16;
/** Cap on recognized text length per text layer. */
const MAX_LAYER_TEXT = 200;
const LAYER_SYSTEM_PROMPT = [
	"你是图像图层拆解引擎。用户会给你一张图片，请把它拆成可独立编辑的图层，并且只输出一个 JSON 对象，不要输出任何解释、markdown 或代码块。",
	"输出格式：",
	"{\"layers\":[{\"kind\":\"background\",\"label\":\"背景\"},{\"kind\":\"object\",\"label\":\"人物\",\"rect\":{\"x\":0.1,\"y\":0.2,\"width\":0.3,\"height\":0.5}},{\"kind\":\"text\",\"label\":\"标题\",\"rect\":{\"x\":0.2,\"y\":0.05,\"width\":0.6,\"height\":0.12},\"text\":\"识别出的文字\",\"color\":\"#ffffff\"}]}",
	"规则：",
	"1. rect 使用相对图片的归一化坐标（0~1，原点在左上角），必须是紧贴该元素的矩形框。",
	"2. kind 只能是 background / object / text。background 层不要 rect，只允许一个，排在最前面。",
	"3. text 层必须尽量识别出准确的文字内容（保持原语言与换行），并给出文字颜色（十六进制，如 #ffffff）。",
	"4. 人物、商品、装饰元素、图标等前景元素各占一个 object 层，最多 10 个，按视觉重要性排序。",
	"5. 不要臆造看不见的元素；识别不到文字就不要输出 text 层。"
].join("\n");
function clamp01(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return void 0;
	return Math.min(1, Math.max(0, value));
}
/** Normalize one raw rectangle; undefined when it is degenerate. */
function rectOf(value) {
	if (value === null || typeof value !== "object") return void 0;
	const raw = value;
	let x = clamp01(raw.x);
	let y = clamp01(raw.y);
	let width = clamp01(raw.width ?? raw.w);
	let height = clamp01(raw.height ?? raw.h);
	if (x === void 0 || y === void 0 || width === void 0 || height === void 0) {
		const x2 = clamp01(raw.x2 ?? raw.right);
		const y2 = clamp01(raw.y2 ?? raw.bottom);
		if (x === void 0 || y === void 0 || x2 === void 0 || y2 === void 0) return void 0;
		width = Math.max(0, x2 - x);
		height = Math.max(0, y2 - y);
	}
	if (width === 0 || height === 0) return void 0;
	if (x + width > 1) width = 1 - x;
	if (y + height > 1) height = 1 - y;
	if (width < .005 || height < .005) return void 0;
	return {
		x: Number(x.toFixed(4)),
		y: Number(y.toFixed(4)),
		width: Number(width.toFixed(4)),
		height: Number(height.toFixed(4))
	};
}
function colorOf(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	if (/^#[0-9a-fA-F]{3}$/.test(trimmed) || /^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase();
}
function labelOf(value, fallback) {
	if (typeof value !== "string") return fallback;
	const trimmed = value.trim().replace(/\s+/g, " ");
	return trimmed === "" ? fallback : trimmed.slice(0, 40);
}
const KIND_LABEL = {
	background: "背景",
	object: "元素",
	text: "文字"
};
/** Validate + normalize one raw layer entry. */
function layerOf(value) {
	if (value === null || typeof value !== "object") return void 0;
	const raw = value;
	const kind = raw.kind ?? raw.type;
	if (kind !== "background" && kind !== "object" && kind !== "text") return void 0;
	const label = labelOf(raw.label ?? raw.name, KIND_LABEL[kind]);
	if (kind === "background") return {
		kind,
		label
	};
	const rect = rectOf(raw.rect ?? raw.box ?? raw.bounds);
	if (rect === void 0) return void 0;
	if (kind === "text") {
		const text = typeof raw.text === "string" ? raw.text.trim() : typeof raw.content === "string" ? raw.content.trim() : "";
		if (text === "") return void 0;
		const color = colorOf(raw.color);
		return {
			kind,
			label,
			rect,
			text: text.slice(0, MAX_LAYER_TEXT),
			...color === void 0 ? {} : { color }
		};
	}
	return {
		kind,
		label,
		rect
	};
}
/** Pull the JSON object out of a model answer that may wrap it in prose/fences. */
function jsonPayload(content) {
	const cleaned = stripReasoning(content).replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	if (start < 0 || end <= start) return void 0;
	try {
		return JSON.parse(cleaned.slice(start, end + 1));
	} catch {
		return;
	}
}
/** Normalize a raw plan into the wire shape (background first, capped). */
function normalizeLayerPlan(value) {
	if (value === null || typeof value !== "object") return void 0;
	const raw = value;
	const list = Array.isArray(raw.layers) ? raw.layers : Array.isArray(value) ? value : void 0;
	if (list === void 0) return void 0;
	const parsed = list.flatMap((item) => {
		const layer = layerOf(item);
		return layer === void 0 ? [] : [layer];
	});
	if (parsed.length === 0) return void 0;
	const order = {
		background: 0,
		object: 1,
		text: 2
	};
	return { layers: parsed.sort((a, b) => order[a.kind] - order[b.kind]).filter((layer, index, all) => layer.kind !== "background" || all.findIndex((item) => item.kind === "background") === index).slice(0, MAX_LAYERS) };
}
/**
* Decompose one image into a layer plan through the configured chat model.
* The image travels as an OpenAI-style `image_url` data URL, so the model must
* accept vision input; endpoints without it answer with an upstream error that
* is surfaced verbatim.
*/
async function analyzeLayers(config, image) {
	if (config.apiUrl.trim() === "" || config.model.trim() === "") throw new Error("图层拆分需要先在左侧「生图配置」的「提示词增强」中配置一个支持视觉的聊天模型（API 地址 + 模型）");
	const response = await fetch(`${config.apiUrl.replace(/\/+$/, "")}/chat/completions`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...config.apiKey.trim() === "" ? {} : { authorization: `Bearer ${config.apiKey.trim()}` }
		},
		body: JSON.stringify({
			model: config.model.trim(),
			temperature: .2,
			messages: [{
				role: "system",
				content: LAYER_SYSTEM_PROMPT
			}, {
				role: "user",
				content: [{
					type: "text",
					text: "请拆解这张图片的图层，只输出 JSON。"
				}, {
					type: "image_url",
					image_url: { url: image }
				}]
			}]
		})
	});
	const body = await response.json().catch(() => void 0);
	if (!response.ok) {
		const message = body !== null && typeof body === "object" ? body.error?.message : void 0;
		throw new Error(typeof message === "string" && message !== "" ? message : `HTTP ${response.status}`);
	}
	const choices = body !== null && typeof body === "object" && Array.isArray(body.choices) ? body.choices : [];
	const content = choices[0] !== null && typeof choices[0] === "object" ? choices[0].message?.content : void 0;
	if (typeof content !== "string" || content.trim() === "") throw new Error("聊天模型没有返回图层数据");
	const plan = normalizeLayerPlan(jsonPayload(content));
	if (plan === void 0) throw new Error("聊天模型返回的图层 JSON 无法解析（可能不支持视觉输入）");
	return plan;
}
//#endregion
//#region src/image-models.ts
/**
* Image-model configuration shared by the host, panel, and Agent tools.
* `/models` exposes candidates only: the configured list is the explicit
* allow-list because OpenAI-compatible gateways rarely advertise modalities.
*/
const DEFAULT_IMAGE_MODELS = [
	"gpt-image-2.5",
	"gpt-image-2",
	"grok-imagine-image",
	"nanobanana2",
	"nanobanana2-lite",
	"nanobanana-pro",
	"seedream-5.0-pro",
	"glm-image"
];
/** Normalize user-entered model identifiers and retain a usable legacy default. */
function normalizeImageModels(value) {
	const candidates = Array.isArray(value) ? value : [];
	const unique = /* @__PURE__ */ new Set();
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const model = candidate.trim();
		if (model !== "") unique.add(model);
	}
	return unique.size > 0 ? [...unique] : [...DEFAULT_IMAGE_MODELS];
}
//#endregion
//#region src/image-format.ts
function detectImageMime(data) {
	const startsWith = (...bytes) => bytes.every((value, index) => data[index] === value);
	if (startsWith(137, 80, 78, 71, 13, 10, 26, 10)) return "image/png";
	if (startsWith(255, 216, 255)) return "image/jpeg";
	if (startsWith(71, 73, 70, 56, 55, 97) || startsWith(71, 73, 70, 56, 57, 97)) return "image/gif";
	if (startsWith(82, 73, 70, 70) && data[8] === 87 && data[9] === 69 && data[10] === 66 && data[11] === 80) return "image/webp";
}
//#endregion
//#region src/diagnostics-store.ts
/** How many attempts to retain. Bounded so a long session cannot grow. */
const DIAGNOSTIC_MAX = 200;
/** Cap on any recorded excerpt, in characters. */
const DIAGNOSTIC_EXCERPT_MAX = 2e3;
/**
* Mask anything that looks like a credential. The store is meant to be copied
* into a public issue thread, so this runs on every string it keeps: Bearer
* tokens, common key prefixes, query-string secrets and long base64 blobs
* (image payloads would otherwise swamp the buffer).
*/
function redactDiagnosticText(value, limit = DIAGNOSTIC_EXCERPT_MAX) {
	let text = value;
	text = text.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 <redacted>");
	text = text.replace(/\b(sk|rk|pk|api|key|token|secret)[-_][A-Za-z0-9._-]{8,}/gi, "<redacted-key>");
	text = text.replace(/([?&](?:api[_-]?key|key|token|access_token|apikey)=)[^&\s"']+/gi, "$1<redacted>");
	text = text.replace(/("(?:api[_-]?key|key|token|secret|authorization)"\s*:\s*")[^"]*(")/gi, "$1<redacted>$2");
	text = text.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi, (match) => {
		return `${match.slice(0, match.indexOf(","))},<${match.length} chars of base64 redacted>`;
	});
	text = text.replace(/(?<![A-Za-z0-9+/=])[A-Za-z0-9+/=]{200,}(?![A-Za-z0-9+/=])/g, "<long-base64 redacted>");
	return text.length > limit ? `${text.slice(0, limit)}…[truncated ${text.length - limit} chars]` : text;
}
/** Bounded excerpt of a body value (object → JSON, string → as-is). */
function excerptOf(value, limit = DIAGNOSTIC_EXCERPT_MAX) {
	if (value === void 0 || value === null || value === "") return void 0;
	if (Buffer.isBuffer(value)) return `<${value.byteLength} bytes of binary>`;
	let text;
	if (typeof value === "string") text = value;
	else try {
		text = JSON.stringify(value);
	} catch {
		text = String(value);
	}
	if (text === "") return void 0;
	return redactDiagnosticText(text, limit);
}
/** Byte length of a request body without materialising it twice. */
function bodyByteLength(body) {
	if (body === void 0 || body === null) return void 0;
	if (typeof body === "string") return Buffer.byteLength(body, "utf8");
	if (Buffer.isBuffer(body)) return body.byteLength;
}
/**
* The process-wide diagnostics buffer. One instance per host: generation runs
* in a single queue, so a module-level singleton keeps every entry reachable
* from the routes without threading a dependency through the engine.
*/
var DiagnosticStore = class {
	entries = [];
	sequence = 0;
	/** Record one attempt and return the stored entry. */
	record(input) {
		this.sequence += 1;
		const entry = {
			...input,
			id: `diag-${Date.now().toString(36)}-${this.sequence.toString(36)}`,
			at: Date.now(),
			durationMs: Math.max(0, Math.round(input.durationMs ?? 0)),
			hadAuth: input.hadAuth ?? false,
			...input.bodyExcerpt === void 0 ? {} : { bodyExcerpt: redactDiagnosticText(input.bodyExcerpt) },
			...input.requestExcerpt === void 0 ? {} : { requestExcerpt: redactDiagnosticText(input.requestExcerpt) },
			message: redactDiagnosticText(input.message)
		};
		this.entries.unshift(entry);
		if (this.entries.length > 200) this.entries.length = 200;
		return entry;
	}
	list() {
		return this.entries.map((entry) => ({ ...entry }));
	}
	/** Drop everything; the panel's Clear action. */
	clear() {
		this.entries = [];
	}
};
const store = new DiagnosticStore();
/** Record one upstream attempt. */
function recordDiagnostic(input) {
	return store.record(input);
}
/** Snapshot the retained attempts, newest first. */
function listDiagnostics() {
	return store.list();
}
/** Clear the retained attempts. */
function clearDiagnostics() {
	store.clear();
}
/**
* Pull the most useful diagnostic fields out of a thrown value. Fetch rejects
* with an AggregateError whose `cause`/`errors` carry the real network code,
* so the code has to be dug out rather than read off the top-level error.
*/
function networkErrorFields(error) {
	const codes = [];
	const messages = [];
	const seen = /* @__PURE__ */ new Set();
	const visit = (value, depth) => {
		if (value === null || value === void 0 || depth > 4 || seen.has(value)) return;
		if (typeof value === "object") seen.add(value);
		if (typeof value === "string") {
			if (value !== "") messages.push(value);
			return;
		}
		if (typeof value !== "object") return;
		const record = value;
		for (const key of [
			"code",
			"errno",
			"name"
		]) {
			const field = record[key];
			if (typeof field === "string" && field !== "") codes.push(field);
		}
		if (typeof record.message === "string" && record.message !== "") messages.push(record.message);
		if (Array.isArray(record.errors)) for (const item of record.errors) visit(item, depth + 1);
		visit(record.cause, depth + 1);
	};
	visit(error, 0);
	const preferred = codes.find((code) => /^[A-Z]+_?[A-Z0-9_]*$/.test(code) && code !== "Error");
	const detail = [...new Set(messages)].join(" | ");
	return {
		...preferred === void 0 ? {} : { errorCode: preferred },
		detail: detail === "" ? String(error) : detail
	};
}
/**
* Read a Response body as text without consuming the stream twice.
*
* Returns the RAW text: callers parse it, so it must never be redacted here.
* Redaction is applied only when the text is stored (see `redactDiagnosticText`
* and `DiagnosticStore.record`), which keeps generated image payloads intact.
*/
async function readResponseText(response) {
	try {
		return await response.clone().text();
	} catch {
		return "";
	}
}
/**
* Read a bounded, REDACTED excerpt of a Response body for the diagnostics
* record. Only for recording: never feed the result back into parsing.
*/
async function readResponseExcerpt(response, limit = DIAGNOSTIC_EXCERPT_MAX) {
	const text = await readResponseText(response);
	if (text === "") return void 0;
	return redactDiagnosticText(text, limit);
}
//#endregion
//#region src/engine.ts
/**
* Upstream proxy engine: forwards a generate request to the configured
* OpenAI-compatible image endpoint (/images/generations for text-to-image,
* /images/edits for image-to-image) and normalizes the response to base64
* images so the browser never fetches the upstream itself.
*
* Framework-free (no cordis imports) so the route layer and tests can drive
* it directly.
*/
/** A generation failure with a user-presentable message. */
var ImageGenError = class extends Error {
	/** Stable wire code. */
	code;
	constructor(message, code = "generate-failed") {
		super(message);
		this.name = "ImageGenError";
		this.code = code;
	}
};
/** Total budget for the upstream generation call (image models are slow). */
const UPSTREAM_TIMEOUT_MS = 24e4;
/** Budget for downloading one result image URL. */
const IMAGE_FETCH_TIMEOUT_MS = 6e4;
/** Cap on the reference image payload (edit mode), in bytes. */
const MAX_EDIT_IMAGE_BYTES = 10 * 1024 * 1024;
/** Sizes dall-e-3 accepts; anything else falls back to its square default. */
const DALLE3_SIZES = /* @__PURE__ */ new Set([
	"1024x1024",
	"1792x1024",
	"1024x1792"
]);
/** The wire model id for a request: `upstream` (host-filled alias mapping)
*  wins, then the alias, then the family default. */
function wireModel(request) {
	const upstream = request.upstream?.trim();
	if (upstream !== void 0 && upstream !== "") return upstream;
	const alias = request.model.trim();
	return alias === "" ? "gpt-image-2" : alias;
}
/** Whether the model is an xAI Grok Imagine model (grok-imagine-image,
*  grok-imagine-image-2.0, …). Grok Imagine speaks JSON on both endpoints
*  and exposes its own aspect-ratio / response-format knobs instead of the
*  OpenAI size/quality/detail passthrough. */
function isGrokImagine(model) {
	return modelFamily(model) === "grok";
}
/** Whether the model belongs to the Google Nano Banana family (nanobanana2 /
*  nanobanana2-lite / nanobanana-pro, plus the official Gemini image IDs the
*  gateways expose). OpenAI-compatible gateways serve these with their own
*  aspect_ratio / image_size vocabulary instead of the OpenAI size/quality
*  passthrough. */
function isNanoBanana(model) {
	return modelFamily(model) === "nanobanana";
}
/** Whether the model belongs to the ByteDance Seedream family (seedream-5.0-pro,
*  seedream-5.0, seedream-4.x, doubao-seedream-…). OpenAI-compatible gateways
*  serve Seedream through a unified generate-and-edit architecture:
*  generation AND editing both go to /images/generations and reference images
*  are a JSON URL / data-URL array. */
function isSeedream(model) {
	return modelFamily(model) === "seedream";
}
/** Whether the model uses the official Zhipu image-generation contract. */
function isZhipuImage(model) {
	return modelFamily(model) === "zhipu";
}
/** Whether the model is Alibaba Qwen-Image, which speaks the DashScope native
*  multimodal-generation contract (NOT OpenAI-compatible): a chat-style
*  messages body, `宽*高` pixel sizes, and image URLs in the reply content. */
function isQwenImage(model) {
	return modelFamily(model) === "qwen";
}
/** ModelScope's OpenAI-compatible image inference API always queues tasks. */
function isModelScopeInference(baseUrl) {
	try {
		return new URL(baseUrl).hostname.toLowerCase() === "api-inference.modelscope.cn";
	} catch {
		return false;
	}
}
/** Normalize ModelScope's documented service-origin URL to its OpenAI API root. */
function normalizeModelScopeBaseUrl(baseUrl, apiUrlFull) {
	if (apiUrlFull || !isModelScopeInference(baseUrl)) return baseUrl;
	try {
		const url = new URL(baseUrl);
		if (url.pathname === "" || url.pathname === "/") url.pathname = "/v1";
		return url.toString().replace(/\/$/, "");
	} catch {
		return baseUrl;
	}
}
/** Recover the versioned API base when a channel stores the exact generation URL. */
function modelScopeTaskBaseUrl(baseUrl, apiUrlFull) {
	if (!apiUrlFull) return baseUrl;
	try {
		const url = new URL(baseUrl);
		url.pathname = url.pathname.replace(/\/images\/(?:generations|edits)\/?$/i, "");
		url.search = "";
		url.hash = "";
		return url.toString().replace(/\/$/, "");
	} catch {
		return baseUrl;
	}
}
/** Whether the model is MiniMax image-01, which speaks MiniMax's native
*  `/image_generation` contract (NOT OpenAI-compatible): `aspect_ratio`,
*  `subject_reference` for image-to-image, `data.image_base64[]` results, and
*  errors reported as HTTP 200 + non-zero `base_resp.status_code`. */
function isMiniMaxImage(model) {
	return modelFamily(model) === "minimax";
}
/** Aspect ratios MiniMax image-01 documents (the panel vocabulary is a superset). */
const MINIMAX_RATIOS = /* @__PURE__ */ new Set([
	"1:1",
	"16:9",
	"4:3",
	"3:2",
	"2:3",
	"3:4",
	"9:16",
	"21:9"
]);
/** MiniMax caps one request at 9 images. */
const MINIMAX_MAX_N = 9;
/** MiniMax image-01 rejects prompts of 1500+ characters; the exact number
*  lives in model-catalog.ts so the panel counter and this guard agree. */
function isGlmImage(model) {
	return /^glm-image(?:-|$)/i.test(model.trim());
}
/** Whether this is the official Volcengine Ark model naming convention. */
function isVolcSeedream(model) {
	return /^doubao-seedream(?:-|$)/i.test(model.trim());
}
/** Volcengine uses `size` for the output tier, not the panel's aspect ratio. */
function seedreamSize(quality) {
	if (quality === "1k") return "1K";
	return "2K";
}
/** The panel's aspect ratios mapped to Qwen-Image's `宽*高` pixel sizes.
*  The classic series (qwen-image / -plus / -max) documents this fixed list;
*  2.0 / 3.0-series models accept any size within their pixel budget and
*  recommend the larger set. */
const QWEN_SIZE_CLASSIC = {
	"16:9": "1664*928",
	"21:9": "1664*928",
	"4:3": "1472*1104",
	"3:2": "1472*1104",
	"1:1": "1328*1328",
	"3:4": "1104*1472",
	"2:3": "1104*1472",
	"9:16": "928*1664"
};
const QWEN_SIZE_HD = {
	"16:9": "2688*1536",
	"21:9": "2688*1536",
	"4:3": "2368*1728",
	"3:2": "2368*1728",
	"1:1": "2048*2048",
	"3:4": "1728*2368",
	"2:3": "1728*2368",
	"9:16": "1536*2688"
};
/** Versioned ids (qwen-image-2.0 / -3.0-pro / …) take the large size set. */
function isVersionedQwenImage(model) {
	return /^qwen-image-\d+\.\d/i.test(model.trim());
}
function qwenSize(model, ratio) {
	if (ratio === "" || ratio === "auto") return void 0;
	return (isVersionedQwenImage(model) ? QWEN_SIZE_HD : QWEN_SIZE_CLASSIC)[ratio];
}
/** The panel's aspect ratios mapped to the closest OpenAI pixel size
*  (gpt-image-2 / generic OpenAI-compatible endpoints). */
const OPENAI_SIZE_BY_RATIO = {
	"1:1": "1024x1024",
	"3:4": "1024x1536",
	"4:3": "1536x1024",
	"9:16": "1024x1792",
	"2:3": "1024x1536",
	"3:2": "1536x1024",
	"16:9": "1792x1024",
	"21:9": "1792x1024"
};
/** Panel ratios that need renaming for a model's vocabulary. Grok documents
*  20:9 as its ultra-wide ratio, so the panel's 21:9 label is sent as 20:9. */
const GROK_ASPECT_ALIASES = { "21:9": "20:9" };
/**
* One request-scoped timeout that is cleared as soon as its fetch settles.
* AbortSignal.timeout() cannot be disposed early; using it inside a long-lived
* task queue leaves an otherwise idle Node process holding every timeout.
*/
function requestSignal(source, timeoutMs) {
	const controller = new AbortController();
	const abortFromSource = () => {
		controller.abort(source?.reason);
	};
	if (source?.aborted === true) abortFromSource();
	else source?.addEventListener("abort", abortFromSource, { once: true });
	const timeout = setTimeout(() => {
		controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
	}, timeoutMs);
	timeout.unref();
	return {
		signal: controller.signal,
		dispose: () => {
			clearTimeout(timeout);
			source?.removeEventListener("abort", abortFromSource);
		}
	};
}
/** Whether an error was produced by a requestSignal budget timeout. These can
* surface from the fetch call itself or from reading the response body, so the
* budget must stay armed until the body has been consumed. */
function isBudgetTimeout(error) {
	return (error instanceof DOMException || error instanceof Error) && error.name === "TimeoutError";
}
/** Content-type extension hints for URL-fetched images. */ function mimeOfExtension(path) {
	const match = /\.([a-z0-9]+)$/i.exec(path);
	if (match === null) return void 0;
	switch (match[1].toLowerCase()) {
		case "png": return "image/png";
		case "jpg":
		case "jpeg": return "image/jpeg";
		case "webp": return "image/webp";
		case "gif": return "image/gif";
		default: return;
	}
}
/** Parse `data:<mime>;base64,<payload>` into its parts; undefined when malformed. */
function parseDataUrl(dataUrl) {
	const match = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUrl.trim());
	if (match === null || match[3] === void 0) return void 0;
	if (match[2] === void 0) return;
	return {
		mime: match[1] ?? "application/octet-stream",
		base64: match[3]
	};
}
/** Strip a data: prefix from an upstream b64 payload if a gateway added one. */
function bareBase64(value) {
	const parsed = parseDataUrl(value);
	return parsed !== void 0 && parsed.base64 !== void 0 ? parsed.base64 : value;
}
/** Whether a result URL carries cloud-storage signing credentials. */
function isPresignedUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	const params = new Set(Array.from(url.searchParams.keys(), (key) => key.toLowerCase()));
	if (params.has("x-goog-signature") || params.has("x-goog-credential")) return true;
	if (params.has("x-amz-signature") || params.has("x-amz-credential")) return true;
	return params.has("signature") && (params.has("expires") || params.has("googleaccessid") || params.has("awsaccesskeyid"));
}
/** Resolve the request URL for a channel: base URL + path, or the exact URL. */
function endpointUrl(upstream, baseUrl, path) {
	return upstream.apiUrlFull === true ? baseUrl : `${baseUrl}${path}`;
}
/**
* Whether a result URL lives on the same origin as the configured API base.
* The upstream Bearer key is only ever forwarded to this origin: a provider
* (or a compromised relay) that hands back an image URL on a foreign host
* must not be able to harvest the key through that download.
*/
function isSameOriginAsApi(value, apiUrl) {
	try {
		return new URL(value).origin === new URL(apiUrl).origin;
	} catch {
		return false;
	}
}
/** Clamp the requested image count into the API-accepted range. */
function clampCount(n) {
	if (!Number.isFinite(n)) return 1;
	return Math.min(4, Math.max(1, Math.round(n)));
}
/** Pick the effective per-model request parameters. Never includes `n`: the
*  batch parameter is rejected by Responses-API-based gateways (tools[0].n),
*  so the count is satisfied by parallel single-image requests instead. */
function effectiveParams(request) {
	const model = wireModel(request);
	if (model === "dall-e-3") {
		const pixel = OPENAI_SIZE_BY_RATIO[request.size];
		return {
			model,
			size: pixel !== void 0 && DALLE3_SIZES.has(pixel) ? pixel : "1024x1024"
		};
	}
	if (isGrokImagine(model)) return {
		model,
		...request.size !== "" && request.size !== "auto" ? { aspect_ratio: GROK_ASPECT_ALIASES[request.size] ?? request.size } : {},
		...request.quality !== "" && request.quality !== "auto" ? { resolution: request.quality === "4k" ? "2k" : request.quality } : {},
		response_format: "b64_json"
	};
	if (isNanoBanana(model)) return {
		model,
		...request.size !== "" && request.size !== "auto" ? { aspect_ratio: request.size } : {},
		...request.quality !== "" && request.quality !== "auto" ? { image_size: request.quality.toUpperCase() } : {},
		response_format: "b64_json"
	};
	if (isSeedream(model)) return {
		model,
		size: seedreamSize(request.quality),
		response_format: isVolcSeedream(model) ? "url" : "b64_json"
	};
	if (isZhipuImage(model)) return {
		model,
		...request.size !== "" && request.size !== "auto" && OPENAI_SIZE_BY_RATIO[request.size] !== void 0 ? { size: OPENAI_SIZE_BY_RATIO[request.size] } : {},
		quality: isGlmImage(model) ? "hd" : "standard"
	};
	return {
		model,
		...request.size !== "" && request.size !== "auto" && OPENAI_SIZE_BY_RATIO[request.size] !== void 0 ? { size: OPENAI_SIZE_BY_RATIO[request.size] } : {},
		...request.quality === "1k" ? { quality: "low" } : {},
		...request.quality === "2k" ? { quality: "medium" } : {},
		...request.quality === "4k" ? { quality: "high" } : {},
		...request.detail !== "" ? { detail: request.detail } : {}
	};
}
/** How many single-image requests to issue for the requested image count. */
function effectiveCount(request) {
	if (wireModel(request) === "dall-e-3") return 1;
	return clampCount(request.n);
}
/** Normalize one upstream data item into a base64 image. */
async function normalizeItem(item, upstream, signal) {
	const revisedPrompt = typeof item.revised_prompt === "string" ? item.revised_prompt : void 0;
	if (typeof item.b64_json === "string" && item.b64_json.trim() !== "") {
		const b64 = bareBase64(item.b64_json);
		if (b64.trim() !== "") return {
			b64,
			mime: detectImageMime(Buffer.from(b64, "base64")) ?? "image/png",
			revisedPrompt
		};
	}
	if (typeof item.url !== "string" || item.url === "") throw new ImageGenError("upstream image item has neither b64_json nor url");
	const url = item.url;
	if (url.startsWith("data:")) {
		const parsed = parseDataUrl(url);
		if (parsed === void 0) throw new ImageGenError("upstream returned a malformed data: url");
		return {
			b64: parsed.base64,
			mime: detectImageMime(Buffer.from(parsed.base64, "base64")) ?? parsed.mime,
			revisedPrompt
		};
	}
	const budget = requestSignal(signal, IMAGE_FETCH_TIMEOUT_MS);
	const resultContext = {
		phase: "fetch-result",
		channel: upstream.channelName?.trim() || "默认渠道",
		model: "",
		mode: "result",
		url: displayUrl(url),
		method: "GET",
		hadAuth: upstream.apiKey !== "" && !isPresignedUrl(url) && isSameOriginAsApi(url, upstream.apiUrl),
		startedAt: Date.now()
	};
	try {
		let response;
		try {
			const forwardKey = upstream.apiKey !== "" && !isPresignedUrl(url) && isSameOriginAsApi(url, upstream.apiUrl);
			response = await fetch(url, {
				...forwardKey ? { headers: { authorization: `Bearer ${upstream.apiKey}` } } : {},
				signal: budget.signal
			});
		} catch (error) {
			const failure = new ImageGenError(`failed to fetch the generated image url: ${error instanceof Error ? error.message : String(error)}`);
			recordFailure(resultContext, failure);
			throw failure;
		}
		if (!response.ok) {
			const failure = new ImageGenError(`failed to fetch the generated image url: HTTP ${response.status}`);
			recordFailure(resultContext, failure, {
				status: response.status,
				bodyExcerpt: await readResponseExcerpt(response)
			});
			throw failure;
		}
		const buffer = Buffer.from(await response.arrayBuffer());
		const contentType = response.headers.get("content-type");
		const mime = detectImageMime(buffer) ?? (contentType !== null && contentType !== "" ? contentType.split(";")[0].trim() : mimeOfExtension(url) ?? "image/png");
		return {
			b64: buffer.toString("base64"),
			mime,
			revisedPrompt
		};
	} finally {
		budget.dispose();
	}
}
/** Expand a provider image item whose URL may be a string or an array. */
function imageItemsOf(value) {
	if (typeof value === "string" && value.trim() !== "") return [{ url: value.trim() }];
	if (value === null || typeof value !== "object") return [];
	const item = value;
	if (Array.isArray(item.url)) return item.url.filter((url) => typeof url === "string" && url !== "").map((url) => ({
		...item,
		url
	}));
	return [item];
}
/** Return the data records from the response shapes shared by sync gateways. */
function dataRecordsOf(payload) {
	const data = Array.isArray(payload.data) ? payload.data : payload.data !== null && typeof payload.data === "object" ? [payload.data] : Array.isArray(payload.images) ? payload.images : Array.isArray(payload.output) ? payload.output : void 0;
	if (data === void 0) return void 0;
	return data.filter((entry) => entry !== null && typeof entry === "object");
}
/** Remove reasoning-model wrappers before treating chat content as a user-visible error. */
function stripChatReasoning(value) {
	const withoutClosed = value.replace(/<think>[\s\S]*?<\/think>/gi, "");
	const dangling = /<think>/i.exec(withoutClosed);
	return (dangling === null ? withoutClosed : withoutClosed.slice(0, dangling.index)).trim();
}
/** Whether a URL returned in chat content is plausibly an image resource. */
function isLikelyImageUrl(value) {
	if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(value)) return true;
	try {
		const url = new URL(value);
		if (mimeOfExtension(url.pathname) !== void 0) return true;
		const signal = `${url.hostname}${url.pathname}${url.search}`.toLowerCase();
		return /(?:image|img|photo|picture|cdn|blob|cloudinary|googleusercontent|oaidalle|replicate|fal\.media|files\.oai)/.test(signal);
	} catch {
		return false;
	}
}
/** Parse a complete or fenced JSON value embedded in chat text. */
function parseEmbeddedJson(value) {
	const cleaned = stripChatReasoning(value).replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
	if (cleaned === "") return void 0;
	const attempts = [cleaned];
	const objectStart = cleaned.indexOf("{");
	const objectEnd = cleaned.lastIndexOf("}");
	const arrayStart = cleaned.indexOf("[");
	const arrayEnd = cleaned.lastIndexOf("]");
	if (objectStart >= 0 && objectEnd > objectStart) attempts.push(cleaned.slice(objectStart, objectEnd + 1));
	if (arrayStart >= 0 && arrayEnd > arrayStart) attempts.push(cleaned.slice(arrayStart, arrayEnd + 1));
	for (const attempt of attempts) try {
		const parsed = JSON.parse(attempt);
		if (parsed !== null && typeof parsed === "object") return parsed;
	} catch {}
}
/** Collect image references from structured Chat Completions content. */
function collectChatImageItems(value, out, seen, depth = 0) {
	if (depth > 6 || value === null || value === void 0) return;
	if (typeof value === "string") {
		const parsed = parseEmbeddedJson(value);
		if (parsed !== void 0 && parsed !== value) collectChatImageItems(parsed, out, seen, depth + 1);
		for (const match of value.matchAll(/!\[[^\]]*\]\((?:<)?(https?:\/\/[^)\s>]+|data:image\/[^)\s>]+)(?:>)?\)/gi)) if (match[1] !== void 0) out.push({ url: match[1] });
		for (const match of value.matchAll(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi)) if (match[1] !== void 0) out.push({ url: match[1] });
		const urls = value.match(/(?:https?:\/\/|data:image\/)[^\s"'<>)\]}]+/gi) ?? [];
		for (const raw of urls) {
			const url = raw.replace(/[.,;:!?]+$/, "");
			if (isLikelyImageUrl(url)) out.push({ url });
		}
		return;
	}
	if (Array.isArray(value)) {
		for (const item of value) collectChatImageItems(item, out, seen, depth + 1);
		return;
	}
	if (typeof value !== "object") return;
	const record = value;
	if (seen.has(record)) return;
	seen.add(record);
	if (typeof record.b64_json === "string" && record.b64_json.trim() !== "") out.push({ b64_json: record.b64_json });
	for (const key of [
		"url",
		"image_url",
		"image",
		"output_url"
	]) {
		const item = record[key];
		if (typeof item === "string" && item !== "") {
			if (key !== "url" || isLikelyImageUrl(item)) out.push({ url: item });
		} else if (item !== null && typeof item === "object") {
			const nested = item;
			if (key !== "url" && typeof nested.url === "string" && nested.url !== "") out.push({ url: nested.url });
			else collectChatImageItems(item, out, seen, depth + 1);
		}
	}
	for (const key of [
		"images",
		"content",
		"message",
		"data",
		"output",
		"result"
	]) if (key in record) collectChatImageItems(record[key], out, seen, depth + 1);
}
/** Extract every image candidate from one Chat Completions response. */
function chatImageItemsOf(payload) {
	const out = [];
	const seenValues = /* @__PURE__ */ new Set();
	const data = dataRecordsOf(payload);
	if (data !== void 0) for (const record of data) collectChatImageItems(record, out, seenValues);
	const choices = Array.isArray(payload.choices) ? payload.choices : [];
	for (const choice of choices) {
		if (choice === null || typeof choice !== "object") continue;
		const message = choice.message;
		collectChatImageItems(message, out, seenValues);
		const delta = choice.delta;
		collectChatImageItems(delta, out, seenValues);
	}
	if (out.length === 0) collectChatImageItems(payload.images, out, seenValues);
	const unique = /* @__PURE__ */ new Map();
	for (const item of out) {
		const url = typeof item.url === "string" ? item.url.trim() : "";
		const b64 = typeof item.b64_json === "string" ? item.b64_json.trim() : "";
		const key = url !== "" ? `url:${url}` : b64 !== "" ? `b64:${b64.slice(0, 128)}` : "";
		if (key !== "" && !unique.has(key)) unique.set(key, item);
	}
	return [...unique.values()];
}
/** User-visible text from a Chat response, used only when no image was found. */
function chatErrorTextOf(payload) {
	const first = (Array.isArray(payload.choices) ? payload.choices : [])[0];
	const content = first !== null && typeof first === "object" ? first.message?.content : void 0;
	const pieces = [];
	if (typeof content === "string") pieces.push(stripChatReasoning(content));
	else if (Array.isArray(content)) {
		for (const part of content) if (typeof part === "string") pieces.push(stripChatReasoning(part));
		else if (part !== null && typeof part === "object" && typeof part.text === "string") pieces.push(stripChatReasoning(part.text));
	}
	if (pieces.join("\n").trim() !== "") return pieces.join("\n").trim();
	if (typeof payload.message === "string" && payload.message.trim() !== "") return payload.message.trim();
	const error = payload.error;
	if (error !== null && typeof error === "object" && typeof error.message === "string") return error.message.trim();
}
const ASYNC_PENDING_STATUSES = /* @__PURE__ */ new Set([
	"submitted",
	"pending",
	"processing",
	"running",
	"in_progress",
	"queued"
]);
const ASYNC_COMPLETED_STATUSES = /* @__PURE__ */ new Set([
	"completed",
	"succeeded",
	"succeed",
	"success",
	"done"
]);
const ASYNC_FAILED_STATUSES = /* @__PURE__ */ new Set([
	"failed",
	"failure",
	"cancelled",
	"canceled",
	"error"
]);
const ASYNC_POLL_MAX_MS = 24e4;
const ASYNC_POLL_REQUEST_TIMEOUT_MS = 3e4;
/** Read a provider error message from the common nested locations. */
function asyncErrorMessage(payload, fallback) {
	if (payload !== null && typeof payload === "object") {
		const record = payload;
		const candidates = [record.message, record.error];
		const data = record.data;
		const entries = Array.isArray(data) ? data : [data];
		for (const entry of entries) {
			if (entry === null || typeof entry !== "object") continue;
			const item = entry;
			candidates.push(item.message, item.error);
			const nested = item.error;
			if (nested !== null && typeof nested === "object") candidates.push(nested.message);
		}
		for (const candidate of candidates) {
			if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
			if (candidate !== null && typeof candidate === "object") {
				const message = candidate.message;
				if (typeof message === "string" && message.trim() !== "") return message;
			}
		}
	}
	return fallback;
}
/** Wait between async-provider polls, but wake immediately when cancelled. */
function waitForPoll(ms, signal) {
	return new Promise((resolve, reject) => {
		if (signal?.aborted === true) {
			reject(signal.reason ?? new DOMException("The operation was aborted.", "AbortError"));
			return;
		}
		const onAbort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.reason ?? new DOMException("The operation was aborted.", "AbortError"));
		};
		const done = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const timer = setTimeout(done, ms);
		timer.unref();
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}
/**
* Poll an asynchronous provider task until it yields image records (including ModelScope response fields).
* The total deadline is shared by every poll and the final image downloads;
* local task cancellation propagates through every request and sleep.
*/
async function pollAsyncTask(baseUrl, upstream, taskId, signal, modelScope = false) {
	const deadline = Date.now() + ASYNC_POLL_MAX_MS;
	let delay = 1e3;
	const pollUrl = `${baseUrl}/tasks/${encodeURIComponent(taskId)}`;
	while (Date.now() < deadline) {
		const remaining = deadline - Date.now();
		const budget = requestSignal(signal, Math.min(ASYNC_POLL_REQUEST_TIMEOUT_MS, remaining));
		const context = {
			phase: "poll-task",
			channel: upstream.channelName?.trim() || "默认渠道",
			model: "",
			mode: "poll",
			url: displayUrl(pollUrl),
			method: "GET",
			hadAuth: upstream.apiKey.trim() !== "",
			startedAt: Date.now()
		};
		try {
			let response;
			try {
				response = await fetch(pollUrl, {
					method: "GET",
					headers: {
						authorization: `Bearer ${upstream.apiKey.trim()}`,
						...modelScope ? { "X-ModelScope-Task-Type": "image_generation" } : {}
					},
					signal: budget.signal
				});
			} catch (error) {
				const failure = signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : isBudgetTimeout(error) ? new ImageGenError("上游异步任务轮询超时", "upstream-timeout") : new ImageGenError(`无法轮询上游异步任务：${error instanceof Error ? error.message : String(error)}`, "upstream-unreachable");
				recordFailure(context, failure);
				throw failure;
			}
			const responseText = await readResponseText(response);
			let payload;
			try {
				payload = JSON.parse(responseText);
			} catch (error) {
				const failure = isBudgetTimeout(error) ? new ImageGenError("上游异步任务轮询超时", "upstream-timeout") : new ImageGenError(`上游任务接口返回了非 JSON 响应（HTTP ${response.status}）`, "upstream-invalid");
				recordFailure(context, failure, {
					status: response.status,
					bodyExcerpt: responseText
				});
				throw failure;
			}
			if (!response.ok || payload === null || typeof payload !== "object") {
				const failure = new ImageGenError(asyncErrorMessage(payload, `上游任务轮询失败（HTTP ${response.status}）`), "upstream-rejected");
				recordFailure(context, failure, {
					status: response.status,
					bodyExcerpt: responseText
				});
				throw failure;
			}
			const record = payload;
			const data = record.data;
			const statusRecord = Array.isArray(data) ? data[0] : data !== null && typeof data === "object" ? data : record;
			const statusValue = statusRecord !== null && typeof statusRecord === "object" ? statusRecord.task_status ?? statusRecord.status : void 0;
			const status = typeof statusValue === "string" ? statusValue.toLowerCase() : "";
			if (ASYNC_FAILED_STATUSES.has(status)) throw new ImageGenError(asyncErrorMessage(payload, `上游异步任务失败（${status || "unknown"}）`), "upstream-rejected");
			const nested = statusRecord !== null && typeof statusRecord === "object" ? statusRecord : record;
			const result = nested.result ?? (nested.output !== null && typeof nested.output === "object" ? nested.output.result : void 0) ?? record.result;
			const resultRecord = result !== null && typeof result === "object" ? result : void 0;
			const images = resultRecord?.images ?? resultRecord?.output_images ?? nested.images ?? nested.output_images ?? record.images ?? record.output_images;
			if (ASYNC_COMPLETED_STATUSES.has(status) || images !== void 0) {
				const items = Array.isArray(images) ? images.flatMap(imageItemsOf) : imageItemsOf(images);
				if (items.length > 0) return items;
				if (ASYNC_COMPLETED_STATUSES.has(status)) throw new ImageGenError("上游异步任务完成但没有图片结果", "upstream-empty");
			}
			if (status !== "" && !ASYNC_PENDING_STATUSES.has(status) && !ASYNC_COMPLETED_STATUSES.has(status)) throw new ImageGenError(`上游返回了未知异步任务状态：${status}`, "upstream-invalid");
		} finally {
			budget.dispose();
		}
		await waitForPoll(Math.min(delay, Math.max(1, deadline - Date.now())), signal);
		delay = Math.min(5e3, delay * 2);
	}
	throw new ImageGenError("上游异步任务轮询超时（240 秒）", "upstream-timeout");
}
/**
* Issue one single-image request (never sends `n`). The response is kept as a
* list so a gateway that happens to return several images per call still works.
*/
async function requestOneImage(baseUrl, upstream, request, params, signal) {
	const modelScope = isModelScopeInference(baseUrl);
	const headers = {
		authorization: `Bearer ${upstream.apiKey.trim()}`,
		...modelScope ? { "X-ModelScope-Async-Mode": "true" } : {}
	};
	let body;
	if (request.mode === "edit") {
		if (typeof request.image !== "string" || request.image === "") throw new ImageGenError("图生图需要上传参考图片", "edit-image-missing");
		const decodeReference = (dataUrl) => {
			const parsed = parseDataUrl(dataUrl);
			if (parsed === void 0) throw new ImageGenError("参考图片格式无效", "edit-image-invalid");
			let bytes;
			try {
				bytes = Buffer.from(parsed.base64, "base64");
			} catch {
				throw new ImageGenError("参考图片数据无法解码", "edit-image-invalid");
			}
			if (bytes.byteLength > MAX_EDIT_IMAGE_BYTES) throw new ImageGenError("参考图片超过 10MB 上限", "edit-image-too-large");
			return {
				bytes,
				mime: parsed.mime,
				filename: `reference.${extensionOf$5(parsed.mime)}`
			};
		};
		const primary = decodeReference(request.image);
		const extras = (request.images ?? []).filter((img) => typeof img === "string" && img !== "").slice(0, 4).map(decodeReference);
		if (isGrokImagine(params.model)) {
			headers["content-type"] = "application/json";
			body = JSON.stringify({
				model: params.model,
				prompt: request.prompt,
				image: {
					url: request.image,
					type: "image_url"
				},
				...params.aspect_ratio !== void 0 ? { aspect_ratio: params.aspect_ratio } : {},
				response_format: "b64_json"
			});
		} else if (isNanoBanana(params.model)) {
			const form = new FormData();
			form.append("image", new Blob([primary.bytes], { type: primary.mime }), primary.filename);
			form.append("prompt", request.prompt);
			form.append("model", params.model);
			if (params.aspect_ratio !== void 0) form.append("aspect_ratio", params.aspect_ratio);
			if (params.image_size !== void 0) form.append("image_size", params.image_size);
			body = form;
		} else if (isSeedream(params.model)) {
			headers["content-type"] = "application/json";
			body = JSON.stringify({
				model: params.model,
				prompt: request.prompt,
				image: [request.image, ...(request.images ?? []).filter((img) => typeof img === "string" && img !== "").slice(0, 4)],
				...params.size !== void 0 ? { size: params.size } : {},
				...params.resolution !== void 0 ? { resolution: params.resolution } : {},
				response_format: isVolcSeedream(params.model) ? "url" : "b64_json"
			});
		} else {
			const form = new FormData();
			if (extras.length > 0) for (const [index, reference] of [primary, ...extras].entries()) form.append("image[]", new Blob([reference.bytes], { type: reference.mime }), `reference-${index}.${extensionOf$5(reference.mime)}`);
			else form.append("image", new Blob([primary.bytes], { type: primary.mime }), primary.filename);
			form.append("prompt", request.prompt);
			form.append("model", params.model);
			if (params.size !== void 0) form.append("size", params.size);
			if (params.quality !== void 0) form.append("quality", params.quality);
			if (params.detail !== void 0) form.append("detail", params.detail);
			body = form;
		}
	} else {
		headers["content-type"] = "application/json";
		body = JSON.stringify({
			prompt: request.prompt,
			...params
		});
	}
	const budget = requestSignal(signal, UPSTREAM_TIMEOUT_MS);
	try {
		let response;
		const requestUrl = endpointUrl(upstream, baseUrl, request.mode === "edit" && !isSeedream(params.model) ? "/images/edits" : "/images/generations");
		const context = attemptContext(upstream, request, "generate", requestUrl, "POST", body, Date.now());
		try {
			response = await fetch(requestUrl, {
				method: "POST",
				headers,
				body,
				signal: budget.signal
			});
		} catch (error) {
			const network = networkErrorFields(error);
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`无法连接上游接口：${network.detail}${network.errorCode === void 0 ? "" : ` [${network.errorCode}]`} · 请求地址 ${displayUrl(requestUrl)}`, "upstream-unreachable");
			recordFailure(context, failure);
			throw failure;
		}
		let payload;
		const responseText = await readResponseText(response);
		try {
			payload = JSON.parse(responseText);
		} catch (error) {
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`上游接口返回了非 JSON 响应（HTTP ${response.status}）`, "upstream-invalid");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		if (!response.ok || payload === null || typeof payload !== "object") {
			const failure = new ImageGenError(`${upstreamMessage(payload, response.status)}（HTTP ${response.status} · ${displayUrl(requestUrl)}）`, "upstream-rejected");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText,
				responseBytes: Buffer.byteLength(responseText, "utf8")
			});
			throw failure;
		}
		const record = payload;
		const modelScopeTaskId = modelScope && typeof record.task_id === "string" ? record.task_id.trim() : "";
		if (modelScopeTaskId !== "") {
			const taskItems = await pollAsyncTask(modelScopeTaskBaseUrl(baseUrl, upstream.apiUrlFull === true), upstream, modelScopeTaskId, signal, true);
			if (taskItems.length === 0) throw new ImageGenError("魔搭异步任务已完成，但没有图片结果", "upstream-empty");
			return Promise.all(taskItems.flatMap(imageItemsOf).map((item) => normalizeItem(item, upstream, signal)));
		}
		const data = dataRecordsOf(record);
		if (data === void 0) throw new ImageGenError("上游响应缺少 data 数组", "upstream-invalid");
		if (data.length === 0) throw new ImageGenError("上游返回了 0 张图片", "upstream-empty");
		const asyncEntries = data.filter((entry) => typeof entry.task_id === "string" && entry.task_id.trim() !== "");
		if (asyncEntries.length > 0) {
			const asyncRecords = (await Promise.all(asyncEntries.map((entry) => pollAsyncTask(baseUrl, upstream, entry.task_id, signal)))).flat();
			if (asyncRecords.length === 0) throw new ImageGenError("上游异步任务完成但没有图片结果", "upstream-empty");
			return Promise.all(asyncRecords.flatMap(imageItemsOf).map((item) => normalizeItem(item, upstream, signal)));
		}
		return Promise.all(data.flatMap(imageItemsOf).map((item) => normalizeItem(item, upstream, signal)));
	} finally {
		budget.dispose();
	}
}
/**
* Qwen-Image (DashScope native multimodal-generation): one chat-style request
* carries the prompt (plus the reference image for edit mode) and answers
* synchronously with image URLs in the reply content. The versioned series
* batches natively (n ≤ 6; the panel caps at 4), the classic series is
* single-image per call.
*/
async function generateQwenImage(baseUrl, upstream, request, options) {
	const model = wireModel(request);
	const content = [];
	if (request.mode === "edit") {
		if (typeof request.image !== "string" || request.image === "") throw new ImageGenError("图生图需要上传参考图片", "edit-image-missing");
		const parsed = parseDataUrl(request.image);
		if (parsed === void 0) throw new ImageGenError("参考图片格式无效", "edit-image-invalid");
		if (Buffer.from(parsed.base64, "base64").byteLength > MAX_EDIT_IMAGE_BYTES) throw new ImageGenError("参考图片超过 10MB 上限", "edit-image-too-large");
		content.push({ image: request.image });
	}
	content.push({ text: request.prompt });
	const count = isVersionedQwenImage(model) ? clampCount(request.n) : 1;
	const size = qwenSize(model, request.size);
	const body = {
		model,
		input: { messages: [{
			role: "user",
			content
		}] },
		parameters: {
			...size !== void 0 ? { size } : {},
			...count > 1 ? { n: count } : {}
		}
	};
	const budget = requestSignal(options.signal, UPSTREAM_TIMEOUT_MS);
	try {
		let response;
		const requestUrl = `${baseUrl}/services/aigc/multimodal-generation/generation`;
		const context = attemptContext(upstream, request, "generate", requestUrl, "POST", JSON.stringify(body), Date.now());
		try {
			response = await fetch(requestUrl, {
				method: "POST",
				headers: {
					authorization: `Bearer ${upstream.apiKey.trim()}`,
					"content-type": "application/json"
				},
				body: JSON.stringify(body),
				signal: budget.signal
			});
		} catch (error) {
			const network = networkErrorFields(error);
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : options.signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`无法连接上游接口：${network.detail}${network.errorCode === void 0 ? "" : ` [${network.errorCode}]`} · 请求地址 ${displayUrl(requestUrl)}`, "upstream-unreachable");
			recordFailure(context, failure);
			throw failure;
		}
		let payload;
		const responseText = await readResponseText(response);
		try {
			payload = JSON.parse(responseText);
		} catch (error) {
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : options.signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`上游接口返回了非 JSON 响应（HTTP ${response.status}）`, "upstream-invalid");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		if (!response.ok || payload === null || typeof payload !== "object") {
			const failure = new ImageGenError(`${upstreamMessage(payload, response.status)}（HTTP ${response.status} · ${displayUrl(requestUrl)}）`, "upstream-rejected");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		const output = payload.output;
		const choices = output !== void 0 && Array.isArray(output.choices) ? output.choices : [];
		const urls = [];
		for (const choice of choices) {
			const message = choice !== null && typeof choice === "object" ? choice.message : void 0;
			const items = message !== null && typeof message === "object" && Array.isArray(message.content) ? message.content : [];
			for (const item of items) if (item !== null && typeof item === "object") {
				const image = item.image;
				if (typeof image === "string" && image !== "") urls.push(image);
			}
		}
		if (urls.length === 0) throw new ImageGenError("上游响应缺少图片内容", "upstream-empty");
		return { images: await Promise.all(urls.map(async (url) => {
			const normalized = await normalizeItem({ url }, upstream);
			return {
				b64: normalized.b64,
				mime: normalized.mime
			};
		})) };
	} finally {
		budget.dispose();
	}
}
/**
* MiniMax image-01 (native `/image_generation`): one JSON request that batches
* up to 9 images and returns them inline as base64. Image-to-image rides the
* `subject_reference` array (a character reference, data URL accepted). The
* endpoint answers HTTP 200 even on failure, so `base_resp.status_code` is the
* real verdict.
*/
async function generateMiniMaxImage(baseUrl, upstream, request, options) {
	const model = wireModel(request);
	const promptLimit = promptCharLimit(model);
	if (promptLimit !== null && request.prompt.length >= promptLimit) throw new ImageGenError(`MiniMax image-01 要求提示词少于 ${promptLimit} 字符（当前 ${request.prompt.length}），请精简后重试`, "prompt-too-long");
	const body = {
		model,
		prompt: request.prompt,
		response_format: "base64"
	};
	const ratio = request.size.trim();
	if (ratio !== "" && ratio !== "auto") {
		if (!MINIMAX_RATIOS.has(ratio)) throw new ImageGenError(`MiniMax image-01 不支持 ${ratio} 宽高比，可选：${Array.from(MINIMAX_RATIOS).join(" / ")}`, "size-unsupported");
		body.aspect_ratio = ratio;
	}
	const count = Math.min(MINIMAX_MAX_N, clampCount(request.n));
	if (count > 1) body.n = count;
	if (request.mode === "edit") {
		if (typeof request.image !== "string" || request.image === "") throw new ImageGenError("图生图需要上传参考图片", "edit-image-missing");
		const parsed = parseDataUrl(request.image);
		if (parsed === void 0) throw new ImageGenError("参考图片格式无效", "edit-image-invalid");
		if (Buffer.from(parsed.base64, "base64").byteLength > MAX_EDIT_IMAGE_BYTES) throw new ImageGenError("参考图片超过 10MB 上限", "edit-image-too-large");
		body.subject_reference = [{
			type: "character",
			image_file: request.image
		}];
	}
	const budget = requestSignal(options.signal, UPSTREAM_TIMEOUT_MS);
	try {
		let response;
		const requestUrl = `${baseUrl}/image_generation`;
		const context = attemptContext(upstream, request, "generate", requestUrl, "POST", JSON.stringify(body), Date.now());
		try {
			response = await fetch(requestUrl, {
				method: "POST",
				headers: {
					authorization: `Bearer ${upstream.apiKey.trim()}`,
					"content-type": "application/json"
				},
				body: JSON.stringify(body),
				signal: budget.signal
			});
		} catch (error) {
			const network = networkErrorFields(error);
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : options.signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`无法连接上游接口：${network.detail}${network.errorCode === void 0 ? "" : ` [${network.errorCode}]`} · 请求地址 ${displayUrl(requestUrl)}`, "upstream-unreachable");
			recordFailure(context, failure);
			throw failure;
		}
		let payload;
		const responseText = await readResponseText(response);
		try {
			payload = JSON.parse(responseText);
		} catch (error) {
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : options.signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`上游接口返回了非 JSON 响应（HTTP ${response.status}）`, "upstream-invalid");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		if (payload === null || typeof payload !== "object") {
			const failure = new ImageGenError(`${upstreamMessage(payload, response.status)}（HTTP ${response.status} · ${displayUrl(requestUrl)}）`, "upstream-rejected");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		const record = payload;
		const baseResp = record.base_resp;
		if (baseResp !== null && typeof baseResp === "object") {
			const status = baseResp.status_code;
			if (typeof status === "number" && status !== 0) {
				const msg = baseResp.status_msg;
				throw new ImageGenError(`MiniMax 拒绝请求（${status}）：${typeof msg === "string" && msg !== "" ? msg : "unknown error"}`, status === 1004 || status === 2049 ? "upstream-unauthorized" : "upstream-rejected");
			}
		}
		if (!response.ok) throw new ImageGenError(upstreamMessage(payload, response.status), "upstream-rejected");
		const data = record.data;
		const b64s = data !== null && typeof data === "object" && Array.isArray(data.image_base64) ? data.image_base64.filter((item) => typeof item === "string" && item.trim() !== "") : [];
		const urls = data !== null && typeof data === "object" && Array.isArray(data.image_urls) ? data.image_urls.filter((item) => typeof item === "string" && item !== "") : [];
		if (b64s.length === 0 && urls.length === 0) throw new ImageGenError("上游响应缺少图片内容", "upstream-empty");
		const images = b64s.map((raw) => {
			const b64 = bareBase64(raw);
			return {
				b64,
				mime: detectImageMime(Buffer.from(b64, "base64")) ?? "image/jpeg"
			};
		});
		for (const url of urls) {
			const normalized = await normalizeItem({ url }, upstream, options.signal);
			images.push({
				b64: normalized.b64,
				mime: normalized.mime
			});
		}
		return { images };
	} finally {
		budget.dispose();
	}
}
/** Resolve the exact Chat Completions endpoint for a channel. */
function chatEndpointUrl(upstream, baseUrl) {
	if (isChatCompletionsUrl(baseUrl)) return baseUrl;
	if (upstream.apiUrlFull === true) return baseUrl;
	return `${baseUrl}/chat/completions`;
}
/** One chat-protocol image request; image count is satisfied by parallel calls. */
async function requestOneChatImage(upstream, baseUrl, request, signal) {
	const content = request.mode === "edit" ? [{
		type: "text",
		text: request.prompt
	}, ...[request.image, ...request.images ?? []].filter((value) => typeof value === "string" && value !== "").slice(0, 5).map((url) => ({
		type: "image_url",
		image_url: { url }
	}))] : request.prompt;
	const budget = requestSignal(signal, UPSTREAM_TIMEOUT_MS);
	try {
		let response;
		const requestUrl = chatEndpointUrl(upstream, baseUrl);
		const requestBody = JSON.stringify({
			model: wireModel(request),
			messages: [{
				role: "user",
				content
			}],
			stream: false
		});
		const context = attemptContext(upstream, request, "chat", requestUrl, "POST", requestBody, Date.now());
		try {
			response = await fetch(requestUrl, {
				method: "POST",
				headers: {
					authorization: `Bearer ${upstream.apiKey.trim()}`,
					"content-type": "application/json",
					accept: "application/json"
				},
				body: requestBody,
				signal: budget.signal
			});
		} catch (error) {
			const network = networkErrorFields(error);
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`无法连接上游接口：${network.detail}${network.errorCode === void 0 ? "" : ` [${network.errorCode}]`} · 请求地址 ${displayUrl(requestUrl)}`, "upstream-unreachable");
			recordFailure(context, failure);
			throw failure;
		}
		let payload;
		const responseText = await readResponseText(response);
		try {
			payload = JSON.parse(responseText);
		} catch (error) {
			const failure = isBudgetTimeout(error) ? new ImageGenError("上游接口响应超时（240 秒）", "upstream-timeout") : signal?.aborted === true ? new ImageGenError("任务已取消", "cancelled") : new ImageGenError(`上游接口返回了非 JSON 响应（HTTP ${response.status}）`, "upstream-invalid");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		if (!response.ok || payload === null || typeof payload !== "object") {
			const failure = new ImageGenError(`${upstreamMessage(payload, response.status)}（HTTP ${response.status} · ${displayUrl(requestUrl)}）`, "upstream-rejected");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		const items = chatImageItemsOf(payload);
		if (items.length === 0) {
			const failure = new ImageGenError(chatErrorTextOf(payload)?.slice(0, 1200) || "Chat Completions 响应中没有可用的图片结果", "upstream-empty");
			recordFailure(context, failure, {
				status: response.status,
				bodyExcerpt: responseText
			});
			throw failure;
		}
		return await Promise.all(items.map((item) => normalizeItem(item, upstream, signal)));
	} finally {
		budget.dispose();
	}
}
/** Run N parallel Chat Completions image calls and flatten the result. */
async function generateChatCompletionImages(upstream, baseUrl, request, signal) {
	const count = effectiveCount(request);
	return (await Promise.all(Array.from({ length: count }, () => requestOneChatImage(upstream, baseUrl, request, signal)))).flat();
}
/**
* Forward one generate request to the configured endpoint. The requested image
* count is satisfied with N parallel single-image requests (the `n` batch
* parameter is never sent, because Responses-API-based gateways reject it as
* `tools[0].n`), then the results are flattened in order.
*/
async function generateImage(upstream, request, options = {}) {
	const baseUrl = normalizeModelScopeBaseUrl(upstream.apiUrl.trim().replace(/\/+$/, ""), upstream.apiUrlFull === true);
	if (baseUrl === "") throw new ImageGenError("api_url 未配置：请先在「设置 → 生图配置」中填写", "config-missing");
	if (upstream.apiKey.trim() === "") throw new ImageGenError("api_key 未配置：请先在「设置 → 生图配置」中填写", "config-missing");
	if (resolveChannelProtocol(baseUrl, upstream.protocol) === "chat-completions") return { images: await generateChatCompletionImages(upstream, baseUrl, request, options.signal) };
	if (upstream.apiUrlFull !== true) {
		if (!isModelScopeInference(baseUrl) && isQwenImage(wireModel(request))) return generateQwenImage(baseUrl, upstream, request, options);
		if (isMiniMaxImage(wireModel(request))) return generateMiniMaxImage(baseUrl, upstream, request, options);
		if (request.mode === "edit" && isZhipuImage(wireModel(request))) throw new ImageGenError("智谱 GLM-Image 当前仅支持文生图，请切换到文生图模式或选择支持图生图的模型", "edit-unsupported");
	}
	const params = effectiveParams(request);
	const count = effectiveCount(request);
	return { images: (await Promise.all(Array.from({ length: count }, () => requestOneImage(baseUrl, upstream, request, params, options.signal)))).flat() };
}
/**
* The URL actually handed to fetch, with any query string dropped: the
* diagnostics panel exists to answer "which address did it call", and a signed
* query would leak credentials into a bug report.
*/
function displayUrl(url) {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}${parsed.pathname}`;
	} catch {
		return url.split("?")[0] ?? url;
	}
}
/** Record a failed attempt against the diagnostics buffer. */
function recordFailure(context, error, options = {}) {
	const network = networkErrorFields(error);
	recordDiagnostic({
		phase: context.phase,
		channel: context.channel,
		model: context.model,
		mode: context.mode,
		url: context.url,
		method: context.method,
		status: options.status,
		errorCode: network.errorCode,
		failureCode: error.code,
		message: error.message,
		bodyExcerpt: options.bodyExcerpt,
		requestExcerpt: context.requestExcerpt,
		requestBytes: context.requestBytes,
		responseBytes: options.responseBytes,
		durationMs: Date.now() - context.startedAt,
		hadAuth: context.hadAuth,
		apiUrlFull: context.apiUrlFull
	});
}
/** Build the attempt context for one upstream call. */
function attemptContext(upstream, request, phase, url, method, body, startedAt) {
	return {
		phase,
		channel: upstream.channelName?.trim() || "默认渠道",
		model: wireModel(request),
		mode: request.mode,
		url: displayUrl(url),
		method,
		hadAuth: upstream.apiKey.trim() !== "",
		...upstream.apiUrlFull === true ? { apiUrlFull: true } : {},
		requestExcerpt: requestExcerptFor(request, body),
		requestBytes: bodyByteLength(body),
		startedAt
	};
}
/**
* The request excerpt worth keeping. Reference images are stripped (they are
* megabytes of base64 already summarised by requestBytes), keeping the shape
* and the prompt so the panel shows what was actually asked for.
*/
function requestExcerptFor(request, body) {
	if (typeof body === "string") return excerptOf(body);
	const shape = {
		mode: request.mode,
		model: wireModel(request),
		prompt: request.prompt,
		size: request.size,
		quality: request.quality,
		n: request.n
	};
	if (request.image !== void 0) shape.referenceImages = 1 + (request.images?.length ?? 0);
	return excerptOf(shape);
}
/** Human-readable failure message from an upstream error payload. */
function upstreamMessage(payload, status) {
	if (payload !== null && typeof payload === "object") {
		const record = payload;
		const error = record.error;
		if (error !== null && typeof error === "object") {
			const message = error.message;
			if (typeof message === "string" && message !== "") return message;
		}
		if (typeof record.message === "string" && record.message !== "") return record.message;
		if (typeof record.error === "string" && record.error !== "") return record.error;
	}
	return `上游接口拒绝请求（HTTP ${status}）`;
}
/** File extension for a MIME type (multipart reference image). */
function extensionOf$5(mime) {
	switch (mime.split(";")[0].trim()) {
		case "image/jpeg": return "jpg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		default: return "png";
	}
}
//#endregion
//#region src/subscription/oauth.ts
/**
* OAuth primitives shared by the subscription vendors.
*
* Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
* lib/oauth.js, lib/pkce.js, lib/jwt.js — PKCE generation, authorize-URL
* building and the JWT payload reads the vendors need for identity headers.
*/
async function createPkce() {
	const verifier = Buffer.from(randomBytes(32)).toString("base64url");
	return {
		verifier,
		challenge: Buffer.from(createHash("sha256").update(verifier).digest()).toString("base64url"),
		state: Buffer.from(randomBytes(16)).toString("base64url")
	};
}
/** Build an authorization-code URL with PKCE and optional extra params. */
function buildAuthorizeUrl(input) {
	const url = new URL(input.authUrl);
	url.searchParams.set("response_type", "code");
	url.searchParams.set("client_id", input.clientId);
	url.searchParams.set("redirect_uri", input.redirectUri);
	url.searchParams.set("code_challenge", input.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", input.state);
	if (input.scope !== void 0 && input.scope.length > 0) url.searchParams.set("scope", input.scope);
	if (input.extra !== void 0) for (const [key, value] of Object.entries(input.extra)) {
		if (value === null || value === void 0 || value === "") continue;
		url.searchParams.set(key, String(value));
	}
	return url.toString();
}
/** Decode a JWT payload without signature verification (identity read only). */
function decodeJwtPayload(token) {
	const parts = String(token ?? "").split(".");
	if (parts.length < 2) return void 0;
	try {
		const json = Buffer.from(parts[1], "base64url").toString("utf8");
		const parsed = JSON.parse(json);
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** The chatgpt-account-id a Codex API call must carry. */
function chatgptAccountId(token) {
	const payload = decodeJwtPayload(token);
	if (payload === void 0) return "";
	if (typeof payload.chatgpt_account_id === "string") return payload.chatgpt_account_id;
	const nested = payload["https://api.openai.com/auth"];
	if (typeof nested === "object" && nested !== null && typeof nested.chatgpt_account_id === "string") return nested.chatgpt_account_id;
	const orgs = payload.organizations;
	if (Array.isArray(orgs) && orgs[0] !== null && typeof orgs[0] === "object" && typeof orgs[0].id === "string") return orgs[0].id;
	return "";
}
/** The account email for badges and login confirmation. */
function emailFromToken(token) {
	const payload = decodeJwtPayload(token);
	if (payload === void 0) return "";
	const email = payload.email;
	const preferred = payload.preferred_username;
	if (typeof email === "string" && email.length > 0) return email;
	if (typeof preferred === "string") return preferred;
	return "";
}
/** POST an OAuth token endpoint with form encoding; 25s cap like the source. */
async function formTokenRequest(url, params, fetchImpl) {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json"
		},
		body: new URLSearchParams(params).toString(),
		signal: AbortSignal.timeout(25e3)
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`token endpoint HTTP ${String(response.status)}${text.length > 0 ? `: ${text.slice(0, 200)}` : ""}`);
	}
	try {
		const parsed = await response.json();
		return typeof parsed === "object" && parsed !== null ? parsed : {};
	} catch {
		return {};
	}
}
//#endregion
//#region src/subscription/loopback.ts
/**
* Temporary loopback server that catches the OAuth redirect on a vendor-fixed
* local port and hands the code to a handler.
*
* Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
* lib/loopback.js — same protocol (first matching request wins, server shuts
* down, 10-minute cap), restated in TypeScript with this bundle's style.
*/
const OK_HTML = "<!doctype html><meta charset=\"utf-8\"><title>dsh-image-gen</title><p>登录成功，可以关闭此页返回设置。</p>";
const ERR_HTML = "<!doctype html><meta charset=\"utf-8\"><title>dsh-image-gen</title><p>登录失败，请返回设置重试。</p>";
/**
* Loopback addresses accepted by the request handler. On dual-stack systems
* Node reports IPv4-mapped IPv6 addresses as `::ffff:127.0.0.1`, so we must
* accept that form in addition to the canonical IPv4 and IPv6 loopback.
*/
const LOOPBACK_ADDRESSES = /* @__PURE__ */ new Set([
	"127.0.0.1",
	"::1",
	"::ffff:127.0.0.1"
]);
/**
* Listen on the redirect_uri's port and resolve when the provider calls back.
* Rejects on port conflicts, network errors, or when nothing arrives in time.
*/
function startLoopback(options) {
	const parsed = new URL(options.redirectUri);
	if (parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") return Promise.reject(/* @__PURE__ */ new Error(`loopback redirect requires localhost, got ${parsed.hostname}`));
	const port = Number(parsed.port) || 80;
	const path = parsed.pathname;
	const timeoutMs = options.timeoutMs ?? 600 * 1e3;
	const state = { done: false };
	return new Promise((resolve, reject) => {
		const server = http.createServer((req, res) => {
			const remote = req.socket.remoteAddress ?? "";
			if (!LOOPBACK_ADDRESSES.has(remote)) {
				res.writeHead(403);
				res.end();
				return;
			}
			const url = new URL(req.url ?? "/", `http://127.0.0.1:${String(port)}`);
			if (!url.pathname.startsWith(path)) {
				res.writeHead(404, { "Content-Type": "text/html; charset=utf-8" });
				res.end(ERR_HTML);
				return;
			}
			if (state.done) return;
			state.done = true;
			res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
			Promise.resolve(options.onCode(url.searchParams)).then((html) => {
				res.end(html.length > 0 ? html : OK_HTML);
			}).catch(() => {
				res.end(ERR_HTML);
			}).finally(() => {
				clearTimeout(timer);
				server.close();
				resolve({ ok: true });
			});
		});
		server.on("error", (error) => {
			const failure = error instanceof Error ? error : new Error(String(error));
			options.onError?.(failure);
			if (state.done) return;
			state.done = true;
			clearTimeout(timer);
			reject(failure);
		});
		const timer = setTimeout(() => {
			if (state.done) return;
			state.done = true;
			server.close();
			reject(/* @__PURE__ */ new Error("loopback timeout: no callback received"));
		}, timeoutMs);
		server.listen(port, () => {
			options.onReady?.();
		});
	});
}
//#endregion
//#region src/subscription/blob.ts
/**
* OAuth token blob persistence for subscription accounts.
*
* Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
* lib/blob.js — trimmed to the two image vendors this plugin ships. The blob
* is stored through the DSH Credentials service under a provider-scoped ref
* (see refs.ts); it never reaches the browser side.
*/
function asString(value) {
	return value === null || value === void 0 ? "" : String(value);
}
/** Serialize a blob for storage; at least one token must be present. */
function serializeBlob(obj) {
	const accessToken = asString(obj.accessToken);
	const refreshToken = asString(obj.refreshToken);
	if (accessToken.length === 0 && refreshToken.length === 0) throw new Error("oauth blob needs accessToken or refreshToken");
	return JSON.stringify({
		accessToken,
		refreshToken,
		expiresAt: Number(obj.expiresAt) || 0,
		label: asString(obj.label),
		email: asString(obj.email),
		accountId: asString(obj.accountId)
	});
}
/** Parse a stored blob back; invalid input throws. */
function parseBlob(text) {
	const obj = typeof text === "string" ? JSON.parse(text) : text;
	if (typeof obj !== "object" || obj === null) throw new Error("invalid oauth blob");
	const row = obj;
	return {
		accessToken: asString(row.accessToken),
		refreshToken: asString(row.refreshToken),
		expiresAt: Number(row.expiresAt) || 0,
		label: asString(row.label),
		email: asString(row.email),
		accountId: asString(row.accountId)
	};
}
//#endregion
//#region src/subscription/vendors/codex.ts
/**
* ChatGPT (Codex) subscription image vendor.
*
* Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
* lib/vendors/codex.js and lib/images.js — only the pieces the image channel
* needs: authorize URL, code exchange, refresh, and the generations call.
* The device-code flow and chat streaming stay out of this bundle.
*/
const CODEX_AUTH = "https://auth.openai.com/oauth/authorize";
const CODEX_TOKEN = "https://auth.openai.com/oauth/token";
const CODEX_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
/** Where the ChatGPT subscription image request goes. */
const CODEX_IMAGE_URL = "https://chatgpt.com/backend-api/codex/images/generations";
/** Where the ChatGPT subscription image edit request goes. */
const CODEX_IMAGE_EDIT_URL = "https://chatgpt.com/backend-api/codex/images/edits";
/** The model served by this endpoint (probed live: gpt-image-2.5-flare works
* on the ChatGPT internal generations route as of 2026-09-14). */
const CODEX_IMAGE_MODEL = "gpt-image-2.5-flare";
/** Public client id of the Codex CLI; vendor-fixed redirect on port 1455. */
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_REDIRECT_URI = "http://localhost:1455/auth/callback";
function codexConfig() {
	return {
		clientId: CODEX_CLIENT_ID,
		redirectUri: CODEX_REDIRECT_URI
	};
}
function codexAuthorizeUrl(cfg, pkce) {
	return buildAuthorizeUrl({
		authUrl: CODEX_AUTH,
		clientId: cfg.clientId,
		redirectUri: cfg.redirectUri,
		challenge: pkce.challenge,
		state: pkce.state,
		scope: CODEX_SCOPE,
		extra: {
			id_token_add_organizations: "true",
			codex_cli_simplified_flow: "true",
			originator: "codex_cli_rs"
		}
	});
}
/** Identity fields every Codex API call must carry. */
function codexIdentityHeaders(blob) {
	return {
		authorization: `Bearer ${blob.accessToken}`,
		"chatgpt-account-id": blob.accountId,
		originator: "codex_cli_rs",
		"content-type": "application/json",
		accept: "application/json"
	};
}
function decorate(blob, json) {
	const idToken = typeof json.id_token === "string" ? json.id_token : "";
	return {
		...blob,
		accountId: blob.accountId.length > 0 ? blob.accountId : chatgptAccountId(idToken) || chatgptAccountId(blob.accessToken),
		email: blob.email.length > 0 ? blob.email : emailFromToken(idToken) || emailFromToken(blob.accessToken),
		label: blob.label.length > 0 ? blob.label : emailFromToken(idToken) || emailFromToken(blob.accessToken) || "ChatGPT"
	};
}
function tokenBlobFromOAuth$2(json) {
	const access = json.access_token;
	const refresh = json.refresh_token;
	return {
		accessToken: typeof access === "string" ? access : "",
		refreshToken: typeof refresh === "string" ? refresh : "",
		expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1e3,
		label: "",
		email: "",
		accountId: ""
	};
}
async function codexExchangeCode(cfg, pkce, code) {
	const json = await formTokenRequest(CODEX_TOKEN, {
		grant_type: "authorization_code",
		client_id: cfg.clientId,
		code,
		redirect_uri: cfg.redirectUri,
		code_verifier: pkce.verifier
	}, fetch);
	return decorate(tokenBlobFromOAuth$2(json), json);
}
async function codexRefresh(blob) {
	const next = tokenBlobFromOAuth$2(await formTokenRequest(CODEX_TOKEN, {
		grant_type: "refresh_token",
		client_id: CODEX_CLIENT_ID,
		refresh_token: blob.refreshToken
	}, fetch));
	return {
		...next,
		refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
		label: blob.label,
		email: blob.email,
		accountId: blob.accountId.length > 0 ? blob.accountId : next.accountId
	};
}
//#endregion
//#region src/subscription/vendors/grok.ts
/**
* Grok subscription image vendor.
*
* Adapted from @goodandready/dsh-subscriptions (MIT, (c) 2026 GooDAnDReaDY)
* lib/vendors/grok.js and lib/images.js — only the pieces the image channel
* needs: authorize URL, code exchange, refresh, and the generations call
* (grok-cli token, not an xAI API key).
*/
const GROK_AUTH = "https://auth.x.ai/oauth2/authorize";
const GROK_TOKEN = "https://auth.x.ai/oauth2/token";
const GROK_SCOPE = "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write";
/** Where the Grok subscription image request goes. */
const GROK_IMAGE_URL = "https://api.x.ai/v1/images/generations";
/** Where the Grok subscription image edit request goes. */
const GROK_IMAGE_EDIT_URL = "https://api.x.ai/v1/images/edits";
/** The model served by this endpoint. */
const GROK_IMAGE_MODEL = "grok-imagine-image-2.0";
/** Public client id of the grok-cli; vendor-fixed redirect on 127.0.0.1:56121. */
const GROK_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const GROK_REDIRECT_URI = "http://127.0.0.1:56121/callback";
function grokConfig() {
	return {
		clientId: GROK_CLIENT_ID,
		redirectUri: GROK_REDIRECT_URI
	};
}
function grokAuthorizeUrl(cfg, pkce) {
	return buildAuthorizeUrl({
		authUrl: GROK_AUTH,
		clientId: cfg.clientId,
		redirectUri: cfg.redirectUri,
		challenge: pkce.challenge,
		state: pkce.state,
		scope: GROK_SCOPE
	});
}
/** Identity fields every grok.com call must carry (the API host ignores them). */
function grokIdentityHeaders(blob) {
	return {
		authorization: `Bearer ${blob.accessToken}`,
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-client-identifier": "grok-shell",
		"x-grok-client-version": "0.2.103",
		"User-Agent": "xai-grok-cli",
		"content-type": "application/json",
		accept: "application/json"
	};
}
const GROK_DEVICE_CODE_URL = "https://auth.x.ai/oauth2/device/code";
const GROK_DEVICE_SCOPE = "openid profile email offline_access grok-cli:access api:access";
async function grokForm(url, fields, signal, allowDevicePollingStatus = false) {
	const response = await fetch(url, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/x-www-form-urlencoded"
		},
		body: new URLSearchParams(fields).toString(),
		...signal === void 0 ? {} : { signal }
	});
	const body = await response.json().catch(() => ({}));
	if (!response.ok) {
		const error = typeof body.error === "string" ? body.error : "";
		const description = typeof body.error_description === "string" ? body.error_description : "";
		if (allowDevicePollingStatus && (error === "authorization_pending" || error === "slow_down")) return body;
		throw new Error(`xAI OAuth HTTP ${response.status}${error || description ? `: ${[error, description].filter(Boolean).join(": ")}` : ""}`);
	}
	return body;
}
async function grokBeginDeviceLogin(signal) {
	const body = await grokForm(GROK_DEVICE_CODE_URL, {
		client_id: GROK_CLIENT_ID,
		scope: GROK_DEVICE_SCOPE,
		referrer: "pi"
	}, signal);
	const deviceCode = typeof body.device_code === "string" ? body.device_code : "";
	const userCode = typeof body.user_code === "string" ? body.user_code : "";
	const verificationUri = typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : typeof body.verification_uri === "string" ? body.verification_uri : "";
	if (deviceCode === "" || userCode === "" || verificationUri === "") throw new Error("xAI device authorization response is incomplete");
	return {
		deviceCode,
		userCode,
		verificationUri,
		intervalSeconds: typeof body.interval === "number" && body.interval > 0 ? body.interval : 5,
		expiresInSeconds: typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 900
	};
}
async function grokPollDeviceLogin(device, signal) {
	const deadline = Date.now() + device.expiresInSeconds * 1e3;
	let interval = Math.max(1, device.intervalSeconds) * 1e3;
	while (Date.now() < deadline) {
		await new Promise((resolve, reject) => {
			const timer = setTimeout(resolve, interval);
			signal?.addEventListener("abort", () => {
				clearTimeout(timer);
				reject(/* @__PURE__ */ new Error("Login cancelled"));
			}, { once: true });
		});
		const body = await grokForm(GROK_TOKEN, {
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			client_id: GROK_CLIENT_ID,
			device_code: device.deviceCode
		}, signal, true);
		if (typeof body.access_token === "string" && body.access_token !== "") return {
			...tokenBlobFromOAuth$1(body),
			label: "Grok"
		};
		if (body.error === "slow_down" && typeof body.interval === "number") interval = Math.max(1, body.interval) * 1e3;
		else if (body.error !== "authorization_pending") throw new Error(typeof body.error_description === "string" ? body.error_description : `xAI device login failed: ${String(body.error ?? "unknown error")}`);
	}
	throw new Error("xAI device code expired");
}
function tokenBlobFromOAuth$1(json) {
	const access = json.access_token;
	const refresh = json.refresh_token;
	return {
		accessToken: typeof access === "string" ? access : "",
		refreshToken: typeof refresh === "string" ? refresh : "",
		expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1e3,
		label: "",
		email: "",
		accountId: ""
	};
}
async function grokExchangeCode(cfg, pkce, code) {
	const blob = tokenBlobFromOAuth$1(await formTokenRequest(GROK_TOKEN, {
		grant_type: "authorization_code",
		client_id: cfg.clientId,
		code,
		redirect_uri: cfg.redirectUri,
		code_verifier: pkce.verifier
	}, fetch));
	return {
		...blob,
		email: blob.email.length > 0 ? blob.email : emailFromToken(blob.accessToken),
		label: "Grok"
	};
}
async function grokRefresh(blob) {
	const next = tokenBlobFromOAuth$1(await formTokenRequest(GROK_TOKEN, {
		grant_type: "refresh_token",
		client_id: GROK_CLIENT_ID,
		refresh_token: blob.refreshToken
	}, fetch));
	return {
		...next,
		refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
		label: blob.label.length > 0 ? blob.label : "Grok",
		email: blob.email.length > 0 ? blob.email : next.email
	};
}
//#endregion
//#region src/subscription/vendors/openrouter.ts
const OPENROUTER_AUTH = "https://openrouter.ai/auth";
const OPENROUTER_TOKEN = "https://openrouter.ai/api/v1/auth/keys";
const OPENROUTER_REDIRECT_URI = "http://127.0.0.1:56231/oauth/callback";
const OPENROUTER_IMAGE_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_IMAGE_MODEL = "google/gemini-3-pro-image";
function openRouterAuthorizeUrl(pkce) {
	const url = new URL(OPENROUTER_AUTH);
	url.searchParams.set("callback_url", OPENROUTER_REDIRECT_URI);
	url.searchParams.set("code_challenge", pkce.challenge);
	url.searchParams.set("code_challenge_method", "S256");
	url.searchParams.set("state", pkce.state);
	return url.toString();
}
function openRouterIdentityHeaders(blob) {
	return {
		authorization: `Bearer ${blob.accessToken}`,
		"content-type": "application/json",
		accept: "application/json"
	};
}
async function openRouterExchangeCode(pkce, code) {
	const response = await fetch(OPENROUTER_TOKEN, {
		method: "POST",
		headers: {
			accept: "application/json",
			"content-type": "application/json"
		},
		body: JSON.stringify({
			code,
			code_verifier: pkce.verifier,
			code_challenge_method: "S256"
		}),
		signal: AbortSignal.timeout(3e4)
	});
	const json = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(`OpenRouter OAuth key exchange failed (HTTP ${response.status})`);
	const key = json.key;
	if (typeof key !== "string" || key.length === 0) throw new Error("OpenRouter OAuth response carries no key");
	return {
		accessToken: key,
		refreshToken: "",
		expiresAt: Number.MAX_SAFE_INTEGER,
		label: "OpenRouter",
		email: "",
		accountId: ""
	};
}
async function openRouterRefresh(blob) {
	return blob;
}
//#endregion
//#region src/subscription/vendors/antigravity.ts
/**
* Google Antigravity (Nano Banana Pro) subscription image vendor.
*
* Protocol adapted from opencode-antigravity-auth-remix (MIT,
* (c) 2026 Darkstarrd-dev, based on NoeFabris/opencode-antigravity-auth):
* Google OAuth with the Antigravity CLI's public client credentials, managed
* project discovery via loadCodeAssist, and image generation through the
* v1internal:streamGenerateContent endpoint with the gemini-3-pro-image
* model. Reference: dist/src/constants.js, dist/src/plugin/image.js,
* dist/src/plugin/project.js.
*
* The dsh-subscriptions antigravity vendor left the OAuth client empty
* (Google's is confidential); the remix package ships the Antigravity CLI's
* own embedded client id/secret, which the community treats as public the
* same way Codex CLI's and grok-cli's are.
*/
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const SCOPE = [
	"https://www.googleapis.com/auth/cloud-platform",
	"https://www.googleapis.com/auth/userinfo.email",
	"https://www.googleapis.com/auth/userinfo.profile",
	"https://www.googleapis.com/auth/cclog",
	"https://www.googleapis.com/auth/experimentsandconfigs"
].join(" ");
/** Antigravity OAuth is experimental and requires user-supplied client credentials. */
const ANTIGRAVITY_REDIRECT_URI = "http://localhost:51121/oauth-callback";
/**
* Endpoint fallback order for generation, mirroring the reference (daily
* sandbox first, then autopush, then prod).
*/
const ANTIGRAVITY_ENDPOINTS = [
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://autopush-cloudcode-pa.sandbox.googleapis.com",
	"https://cloudcode-pa.googleapis.com"
];
/** loadCodeAssist is best supported on prod; discovery tries prod first. */
const LOAD_ENDPOINTS = [
	"https://cloudcode-pa.googleapis.com",
	"https://daily-cloudcode-pa.sandbox.googleapis.com",
	"https://autopush-cloudcode-pa.sandbox.googleapis.com"
];
/** The image model served through this channel: Nano Banana Pro. */
const ANTIGRAVITY_IMAGE_MODEL = "gemini-3-pro-image";
/**
* Antigravity client version carried in the browser User-Agent. Google's
* backend routes by this: a non-Antigravity or outdated UA lands in the
* enterprise-license check and fails with the misleading 403 #3501
* "You do not have a valid license of this product". The official
* auto-updater publishes the current version; changelog scrape and the
* hardcoded fallback keep the header sane when the updater is unreachable
* (same strategy as the reference implementation's version.js).
*/
const ANTIGRAVITY_VERSION_FALLBACK = "2.0.6";
const VERSION_URL = "https://antigravity-auto-updater-974169037036.us-central1.run.app";
const CHANGELOG_URL = "https://antigravity.google/changelog";
const VERSION_FETCH_TIMEOUT_MS = 5e3;
const CHANGELOG_SCAN_CHARS = 5e3;
const VERSION_REGEX = /\d+\.\d+\.\d+/;
let antigravityVersion;
/** Current client version: the fetched one, or the fallback until fetched. */
function getAntigravityVersion() {
	return antigravityVersion ?? ANTIGRAVITY_VERSION_FALLBACK;
}
/** Fetch and cache the current version once; failures keep the fallback. */
async function initAntigravityVersion() {
	if (antigravityVersion !== void 0) return;
	const parsed = await fetchVersionText(VERSION_URL) ?? await fetchVersionText(CHANGELOG_URL, CHANGELOG_SCAN_CHARS);
	if (parsed !== void 0) antigravityVersion = parsed;
}
async function fetchVersionText(url, maxChars) {
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(VERSION_FETCH_TIMEOUT_MS) });
		if (!response.ok) return void 0;
		let text = await response.text();
		if (maxChars !== void 0) text = text.slice(0, maxChars);
		const match = text.match(VERSION_REGEX);
		return match === null ? void 0 : match[0];
	} catch {
		return;
	}
}
/** Hardcoded fallback project when Antigravity returns none (workspace accounts). */
const DEFAULT_PROJECT_ID = "rising-fact-p41fc";
/** Generation timeout mirroring the reference implementation. */
const IMAGE_TIMEOUT_MS = 12e4;
/** Aspect ratios the generationConfig.imageConfig accepts. */
const ASPECT_RATIOS = [
	"1:1",
	"16:9",
	"9:16",
	"4:3",
	"3:4",
	"21:9"
];
/** Safety settings the image endpoint requires to not block benign prompts. */
const SAFETY_SETTINGS_OFF = [
	{
		category: "HARM_CATEGORY_HARASSMENT",
		threshold: "OFF"
	},
	{
		category: "HARM_CATEGORY_HATE_SPEECH",
		threshold: "OFF"
	},
	{
		category: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
		threshold: "OFF"
	},
	{
		category: "HARM_CATEGORY_DANGEROUS_CONTENT",
		threshold: "OFF"
	},
	{
		category: "HARM_CATEGORY_CIVIC_INTEGRITY",
		threshold: "OFF"
	}
];
function antigravityConfig() {
	const clientId = process.env.ANTIGRAVITY_CLIENT_ID?.trim() ?? "";
	const clientSecret = process.env.ANTIGRAVITY_CLIENT_SECRET?.trim() ?? "";
	if (clientId === "" || clientSecret === "") throw new Error("Google 实验订阅需要设置 ANTIGRAVITY_CLIENT_ID 和 ANTIGRAVITY_CLIENT_SECRET 环境变量");
	return {
		clientId,
		clientSecret,
		redirectUri: ANTIGRAVITY_REDIRECT_URI
	};
}
function antigravityAuthorizeUrl(cfg, pkce) {
	return buildAuthorizeUrl({
		authUrl: AUTH,
		clientId: cfg.clientId,
		redirectUri: cfg.redirectUri,
		challenge: pkce.challenge,
		state: pkce.state,
		scope: SCOPE,
		extra: {
			access_type: "offline",
			prompt: "consent"
		}
	});
}
/**
* Headers for project discovery (loadCodeAssist): the reference keeps the
* plain SDK identity here, mirroring its project.js loadHeaders.
*/
function loadHeaders(projectId) {
	const platform = process.platform === "win32" ? "WINDOWS" : process.platform === "darwin" ? "MACOS" : "LINUX";
	return {
		"User-Agent": "google-api-nodejs-client/9.15.1",
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "ANTIGRAVITY",
			platform,
			pluginType: "GEMINI",
			...projectId.length > 0 ? { duetProject: projectId } : {}
		})
	};
}
/**
* Headers for content requests (image generation): the full Electron
* browser User-Agent with the Antigravity client version, matching the
* official IDE. This is the identity the license check keys on — the plain
* SDK UA here is what produced 403 #3501 on personal accounts.
*/
function contentHeaders(projectId) {
	const uaPlatform = process.platform === "darwin" ? "Macintosh; Intel Mac OS X 10_15_7" : "Windows NT 10.0; Win64; x64";
	const platform = process.platform === "win32" ? "WINDOWS" : process.platform === "darwin" ? "MACOS" : "LINUX";
	return {
		"User-Agent": `Mozilla/5.0 (${uaPlatform}) AppleWebKit/537.36 (KHTML, like Gecko) Antigravity/${getAntigravityVersion()} Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36`,
		"X-Goog-Api-Client": "google-cloud-sdk vscode_cloudshelleditor/0.1",
		"Client-Metadata": JSON.stringify({
			ideType: "ANTIGRAVITY",
			platform,
			pluginType: "GEMINI",
			...projectId.length > 0 ? { duetProject: projectId } : {}
		})
	};
}
function tokenBlobFromOAuth(json) {
	const access = json.access_token;
	const refresh = json.refresh_token;
	const idToken = typeof json.id_token === "string" ? json.id_token : "";
	return {
		accessToken: typeof access === "string" ? access : "",
		refreshToken: typeof refresh === "string" ? refresh : "",
		expiresAt: Date.now() + (Number(json.expires_in) || 3600) * 1e3,
		label: "",
		email: emailFromIdToken(idToken),
		accountId: ""
	};
}
/** Decode the id_token's JWT payload for the account email (identity only). */
function emailFromIdToken(idToken) {
	const parts = idToken.split(".");
	if (parts.length < 2) return "";
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
		return typeof payload.email === "string" ? payload.email : "";
	} catch {
		return "";
	}
}
async function antigravityExchangeCode(cfg, pkce, code) {
	const blob = tokenBlobFromOAuth(await formTokenRequest(TOKEN, {
		client_id: cfg.clientId,
		client_secret: cfg.clientSecret,
		grant_type: "authorization_code",
		code,
		redirect_uri: cfg.redirectUri,
		code_verifier: pkce.verifier
	}, fetch));
	if (blob.accessToken.length === 0) throw new Error("Antigravity token endpoint returned no access token");
	return blob;
}
async function antigravityRefresh(blob) {
	const cfg = antigravityConfig();
	const next = tokenBlobFromOAuth(await formTokenRequest(TOKEN, {
		client_id: cfg.clientId,
		client_secret: cfg.clientSecret,
		grant_type: "refresh_token",
		refresh_token: blob.refreshToken
	}, fetch));
	return {
		...next,
		refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
		label: blob.label,
		email: blob.email.length > 0 ? blob.email : next.email,
		accountId: ""
	};
}
/**
* Resolve the managed project id for the logged-in account. Most accounts
* have one; when loadCodeAssist reports none, the hardcoded fallback keeps
* generation working (mirrors the reference's ensureProjectContext).
* Returns '' only when every endpoint fails, letting generate() throw then.
*/
async function antigravityResolveProject(blob) {
	const metadata = {
		ideType: "ANTIGRAVITY",
		platform: platformOf(),
		pluginType: "GEMINI"
	};
	for (const base of LOAD_ENDPOINTS) try {
		const response = await fetch(`${base}/v1internal:loadCodeAssist`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${blob.accessToken}`,
				...loadHeaders("")
			},
			body: JSON.stringify({ metadata }),
			signal: AbortSignal.timeout(25e3)
		});
		if (!response.ok) continue;
		const payload = await response.json().catch(() => null);
		if (payload === null) continue;
		const project = payload.cloudaicompanionProject;
		const id = typeof project === "string" ? project : typeof project === "object" && project !== null && typeof project.id === "string" ? project.id : "";
		if (id.length > 0) return id;
	} catch {}
	return DEFAULT_PROJECT_ID;
}
function platformOf() {
	if (process.platform === "win32") return "WINDOWS";
	if (process.platform === "darwin") return "MACOS";
	return "LINUX";
}
/**
* Build the streamGenerateContent request body for one image generation.
* Ported from the reference buildImageRequest + the wrapping envelope: no
* tools, no systemInstruction, no thinkingConfig; responseModalities asks
* for TEXT+IMAGE. Reference images (edits) ride along as inlineData parts
* before the text part, mirroring the reference implementation.
*/
function antigravityImageBody(options) {
	const imageConfig = { aspectRatio: options.aspectRatio !== void 0 && ASPECT_RATIOS.includes(options.aspectRatio) ? options.aspectRatio : "1:1" };
	if (options.hd === true) imageConfig.imageSize = "4K";
	const parts = [];
	for (const image of options.referenceImages ?? []) parts.push({ inlineData: {
		mimeType: image.mediaType,
		data: Buffer.from(image.data).toString("base64")
	} });
	parts.push({ text: options.prompt });
	return {
		contents: [{
			role: "user",
			parts
		}],
		generationConfig: {
			candidateCount: 1,
			imageConfig,
			responseModalities: ["TEXT", "IMAGE"]
		},
		safetySettings: SAFETY_SETTINGS_OFF
	};
}
/** Wrap the inner request in the Antigravity agent envelope. */
function antigravityEnvelope(projectId, request) {
	return {
		project: projectId,
		model: ANTIGRAVITY_IMAGE_MODEL,
		userAgent: "antigravity",
		requestId: `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`,
		requestType: "agent",
		request: {
			...request,
			session_id: `sess-${randomUUID()}`
		}
	};
}
/**
* Generate one image on the logged-in Antigravity account: resolve the
* project, POST the wrapped body to each endpoint in fallback order, and
* parse the SSE stream for the inlineData image part.
*/
async function antigravityGenerateImage(options) {
	await initAntigravityVersion();
	const inner = antigravityImageBody({
		prompt: options.prompt,
		...options.aspectRatio !== void 0 ? { aspectRatio: options.aspectRatio } : {},
		...options.hd !== void 0 ? { hd: options.hd } : {},
		...options.referenceImages !== void 0 ? { referenceImages: options.referenceImages } : {}
	});
	const body = antigravityEnvelope(options.projectId, inner);
	let lastError = "no endpoint succeeded";
	for (const base of ANTIGRAVITY_ENDPOINTS) {
		const url = `${base}/v1internal:streamGenerateContent?alt=sse`;
		const timeoutSignal = AbortSignal.timeout(IMAGE_TIMEOUT_MS);
		const signal = options.signal !== void 0 ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: {
					...contentHeaders(options.projectId),
					Authorization: `Bearer ${options.blob.accessToken}`,
					"Content-Type": "application/json",
					Accept: "text/event-stream"
				},
				body: JSON.stringify(body),
				signal
			});
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				lastError = `HTTP ${String(response.status)}: ${text.slice(0, 200)}`;
				if (response.status === 403 || response.status === 404 || response.status === 429 || response.status >= 500) continue;
				throw new Error(`antigravity ${lastError}`);
			}
			const text = await response.text();
			const parsed = parseSseImage(text);
			if (parsed !== void 0) return parsed;
			const reason = parseSseError(text);
			lastError = reason !== void 0 ? reason : "response contained no image";
			continue;
		} catch (error) {
			if (options.signal?.aborted === true) throw error;
			lastError = error instanceof Error ? error.message : String(error);
			continue;
		}
	}
	throw new Error(`antigravity image generation failed: ${lastError}`);
}
/** Scan an SSE body for the first image part in any data: line. */
function parseSseImage(text) {
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const raw = line.slice(6).trim();
		if (raw.length === 0 || raw === "[DONE]") continue;
		try {
			const data = JSON.parse(raw);
			for (const candidate of data.response?.candidates ?? []) for (const part of candidate.content?.parts ?? []) {
				const inline = part.inlineData;
				if (typeof inline?.data === "string" && inline.data.length > 0 && typeof inline.mimeType === "string" && inline.mimeType.startsWith("image/")) return {
					b64: inline.data,
					mimeType: inline.mimeType
				};
			}
		} catch {}
	}
}
/** Pull the first error block an SSE body reports, for better messages. */
function parseSseError(text) {
	for (const line of text.split("\n")) {
		if (!line.startsWith("data: ")) continue;
		const raw = line.slice(6).trim();
		if (raw.length === 0 || raw === "[DONE]") continue;
		try {
			const data = JSON.parse(raw);
			if (data.error !== void 0) {
				const code = typeof data.error.code === "string" || typeof data.error.code === "number" ? String(data.error.code) : "";
				const message = typeof data.error.message === "string" ? data.error.message : "";
				const joined = `${code.length > 0 ? `${code}: ` : ""}${message}`.trim();
				if (joined.length > 0) return joined;
			}
		} catch {}
	}
}
//#endregion
//#region src/subscription/manager.ts
/**
* Subscription account manager: login flows, blob storage through the DSH
* Credentials service, token refresh with per-account locking, and image
* generation on the logged-in account.
*
* The account store pattern follows @goodandready/dsh-subscriptions (MIT,
* (c) 2026 GooDAnDReaDY) lib/accounts.js, trimmed to one account per vendor
* (no rotation, no cooldowns) because this bundle has exactly two vendors
* and no chat adapter to protect.
*
* Isolation invariants (project rules):
* - OAuth blobs live under SUBSCRIPTION_OAUTH_* refs, never the API-key refs.
* - Login/logout never touches any other setting or credential.
* - The browser side never sees a token; it sees the authorize URL and
*   status words only. Generation happens host-side, mirroring every other
*   adapter in this bundle.
*/
/** The vendor each dsh-image-gen subscription provider maps onto. */
function vendorOf(provider) {
	if (provider === "chatgpt-sub") return "codex";
	if (provider === "google-sub") return "antigravity";
	if (provider === "openrouter-sub") return "openrouter";
	return "grok";
}
/** Credential ref one vendor's OAuth blob is stored under (index fixed at 1). */
function subscriptionOauthRef(vendor) {
	return credentialRef(`DSH_IMAGEGEN_${vendor.toUpperCase()}_OAUTH_1`);
}
/**
* Per-application manager instance. Constructed once in the plugin entry,
* owns the pending-login map (PKCE state to login session) and the refresh
* locks; nothing here is persisted except the blobs themselves.
*/
/** Provider names by vendor for login-result pages and errors. */
function providerNameOf(vendor) {
	return SUBSCRIPTION_PROVIDER_DISPLAY_NAMES[vendor === "codex" ? "chatgpt-sub" : vendor === "antigravity" ? "google-sub" : vendor === "openrouter" ? "openrouter-sub" : "grok-sub"];
}
var SubscriptionManager = class {
	ctx;
	pending = /* @__PURE__ */ new Map();
	refreshLocks = /* @__PURE__ */ new Map();
	/** Cheap in-memory expiry cache so badges do not hit credentials on read. */
	blobCache = /* @__PURE__ */ new Map();
	/** Antigravity needs a per-account project id on every generation call. */
	projectCache = /* @__PURE__ */ new Map();
	/** Last failed browser/device login, exposed to the settings card without secrets. */
	loginErrors = /* @__PURE__ */ new Map();
	constructor(ctx) {
		this.ctx = ctx;
	}
	/** Resolve Credentials dynamically so this service stays optional. */
	credentials() {
		const credentials = this.ctx.get("credentials");
		if (credentials === void 0) throw new Error("当前部署未挂载 DSH Credentials，订阅账号不可用");
		return credentials;
	}
	/** Read a vendor's stored blob, or undefined when signed out. */
	async readBlob(vendor) {
		try {
			const raw = (await this.credentials().resolve(subscriptionOauthRef(vendor)))?.value ?? "";
			if (raw.trim().length === 0) return void 0;
			return parseBlob(raw);
		} catch {
			return;
		}
	}
	/** Last login failure for the settings card; never throws. */
	lastLoginError(vendor) {
		return this.loginErrors.get(vendor);
	}
	/** Login status for the settings card; never throws. */
	async loginStatus(vendor) {
		const blob = await this.readBlob(vendor);
		if (blob === void 0) return { state: "logged-out" };
		return {
			state: "logged-in",
			email: blob.email
		};
	}
	/**
	* Begin a login: registers PKCE state, starts the loopback catch server on
	* the vendor-fixed redirect port, and returns the authorize URL for the
	* browser to open. Completion lands in the loopback callback.
	*/
	async beginLogin(vendor) {
		if (vendor === "grok") {
			const device = await grokBeginDeviceLogin();
			this.loginErrors.delete("grok");
			grokPollDeviceLogin(device).then(async (blob) => {
				await this.saveBlob("grok", blob);
				this.loginErrors.delete("grok");
			}).catch((error) => {
				this.loginErrors.set("grok", error instanceof Error ? error.message : String(error));
			});
			return {
				url: device.verificationUri,
				code: device.userCode,
				expiresInSeconds: device.expiresInSeconds
			};
		}
		const redirectUri = vendor === "codex" ? CODEX_REDIRECT_URI : vendor === "antigravity" ? ANTIGRAVITY_REDIRECT_URI : vendor === "openrouter" ? OPENROUTER_REDIRECT_URI : GROK_REDIRECT_URI;
		const pkce = await createPkce();
		this.pending.set(pkce.state, {
			vendor,
			pkce
		});
		const url = vendor === "codex" ? codexAuthorizeUrl(codexConfig(), pkce) : vendor === "antigravity" ? antigravityAuthorizeUrl(antigravityConfig(), pkce) : vendor === "openrouter" ? openRouterAuthorizeUrl(pkce) : grokAuthorizeUrl(grokConfig(), pkce);
		await new Promise((resolve, reject) => {
			let settled = false;
			const ready = () => {
				if (!settled) {
					settled = true;
					resolve();
				}
			};
			const failed = (error) => {
				if (!settled) {
					settled = true;
					reject(error);
				}
			};
			startLoopback({
				redirectUri,
				onReady: ready,
				onError: failed,
				onCode: async (params) => {
					try {
						const html = await this.completeLoginFromCallback(vendor, params.get("code") ?? "", params.get("state") ?? "");
						this.loginErrors.delete(vendor);
						return html;
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						this.loginErrors.set(vendor, message);
						throw error;
					}
				}
			}).catch((error) => {
				failed(error instanceof Error ? error : new Error(String(error)));
			});
		});
		this.loginErrors.delete(vendor);
		return { url };
	}
	/** Complete a browser login from a pasted redirect URL/code when loopback cannot be reached. */
	async completeLogin(vendor, input) {
		const raw = input.trim();
		if (raw === "") throw new Error("authorization redirect URL/code is required");
		let code = "";
		let state = "";
		try {
			const url = new URL(raw);
			code = url.searchParams.get("code") ?? "";
			state = url.searchParams.get("state") ?? "";
		} catch {
			code = raw;
		}
		if (state === "") {
			const found = [...this.pending.entries()].reverse().find(([, row]) => row.vendor === vendor);
			if (found === void 0) throw new Error("login session expired; start again");
			state = found[0];
		}
		try {
			await this.completeLoginFromCallback(vendor, code, state);
			this.loginErrors.delete(vendor);
		} catch (error) {
			this.loginErrors.set(vendor, error instanceof Error ? error.message : String(error));
			throw error;
		}
	}
	/** Loopback callback: validate state, exchange the code, store the blob. */
	async completeLoginFromCallback(vendor, code, state) {
		if (code.length === 0) throw new Error("callback carried no authorization code");
		const row = this.pending.get(state);
		if (row === void 0 || row.vendor !== vendor) throw new Error("login session expired; start again");
		const blob = vendor === "codex" ? await codexExchangeCode(codexConfig(), row.pkce, code) : vendor === "antigravity" ? await antigravityExchangeCode(antigravityConfig(), row.pkce, code) : vendor === "openrouter" ? await openRouterExchangeCode(row.pkce, code) : await grokExchangeCode(grokConfig(), row.pkce, code);
		await this.saveBlob(vendor, blob);
		this.pending.delete(state);
		return `<!doctype html><meta charset="utf-8"><title>dsh-image-gen</title><p>${providerNameOf(vendor)} 登录成功（${escapeHtml(blob.email)}），可以关闭此页返回设置。</p>`;
	}
	/** Sign out: clear the blob and the caches. No other setting changes. */
	async logout(vendor) {
		await this.credentials().unset(subscriptionOauthRef(vendor));
		this.loginErrors.delete(vendor);
		this.blobCache.delete(vendor);
		this.projectCache.clear();
	}
	async saveBlob(vendor, blob) {
		await this.credentials().set(subscriptionOauthRef(vendor), serializeBlob(blob));
		this.blobCache.set(vendor, blob);
	}
	/**
	* Return a blob whose access token is usable; refreshes first when the
	* stored one is expired (or expiring within the skew window). Single-flight
	* per vendor so concurrent generate calls share one refresh.
	*/
	async ensureFresh(vendor) {
		const blob = await this.readBlob(vendor);
		if (blob === void 0) throw notLoggedInError(vendor);
		if (blob.refreshToken.length === 0) return blob;
		if (blob.expiresAt !== 0 && blob.expiresAt - 6e4 > Date.now()) return blob;
		const inflight = this.refreshLocks.get(vendor);
		if (inflight !== void 0) return inflight;
		const refresh = (async () => {
			const next = vendor === "codex" ? await codexRefresh(blob) : vendor === "antigravity" ? await antigravityRefresh(blob) : vendor === "openrouter" ? await openRouterRefresh(blob) : await grokRefresh(blob);
			const merged = {
				...next,
				refreshToken: next.refreshToken.length > 0 ? next.refreshToken : blob.refreshToken,
				accountId: next.accountId.length > 0 ? next.accountId : blob.accountId
			};
			await this.saveBlob(vendor, merged);
			return merged;
		})().finally(() => {
			this.refreshLocks.delete(vendor);
		});
		this.refreshLocks.set(vendor, refresh);
		return refresh;
	}
	/** Generate one image through the logged-in account. b64 reply decoded host-side. */
	async generate(options) {
		const { vendor, prompt } = options;
		const session = await this.ensureFresh(vendor);
		const text = prompt.trim();
		if (text.length === 0) throw new Error("prompt must be a non-empty string");
		const references = options.referenceImages ?? [];
		if (references.length > 5) throw new Error(`订阅生图最多支持 ${String(5)} 张参考图，当前 ${String(references.length)} 张`);
		if (vendor === "openrouter") {
			const response = await fetch(OPENROUTER_IMAGE_URL, {
				method: "POST",
				headers: openRouterIdentityHeaders(session),
				body: JSON.stringify({
					model: OPENROUTER_IMAGE_MODEL,
					messages: [{
						role: "user",
						content: [{
							type: "text",
							text
						}, ...references.map((image) => ({
							type: "image_url",
							image_url: { url: toDataUrl(image) }
						}))]
					}],
					modalities: ["image"],
					stream: false
				}),
				...options.signal === void 0 ? {} : { signal: options.signal }
			});
			const payload = await response.json().catch(() => ({}));
			if (!response.ok) {
				const detail = extractErrorMessage(payload);
				throw new Error(`openrouter HTTP ${String(response.status)}${detail === void 0 ? "" : `: ${detail.slice(0, 200)}`}`);
			}
			return parseOpenRouterImages(payload);
		}
		if (vendor === "antigravity") {
			const projectId = await this.ensureAntigravityProject(session);
			const aspectRatio = antigravityAspectRatioOf(options.size);
			return [{ b64_json: (await antigravityGenerateImage({
				blob: session,
				projectId,
				prompt: text,
				...aspectRatio !== void 0 ? { aspectRatio } : {},
				hd: options.quality === "hd" || options.quality === "high",
				...references.length > 0 ? { referenceImages: references } : {},
				...options.signal !== void 0 ? { signal: options.signal } : {}
			})).b64 }];
		}
		let url;
		let headers;
		let body;
		if (vendor === "codex") {
			url = references.length > 0 ? CODEX_IMAGE_EDIT_URL : CODEX_IMAGE_URL;
			headers = codexIdentityHeaders(session);
			body = {
				prompt: text,
				model: CODEX_IMAGE_MODEL,
				...references.length > 0 ? { images: references.map((image) => ({ image_url: toDataUrl(image) })) } : {},
				...options.size !== void 0 && options.size.length > 0 ? { size: options.size } : {},
				...options.quality !== void 0 && options.quality.length > 0 ? { quality: options.quality } : {}
			};
		} else {
			url = references.length > 0 ? GROK_IMAGE_EDIT_URL : GROK_IMAGE_URL;
			headers = grokIdentityHeaders(session);
			const aspect = {
				"1024x1024": "1:1",
				"1024x1536": "2:3",
				"1536x1024": "3:2",
				auto: "auto"
			};
			const level = options.quality === "low" ? "low" : options.quality === "medium" || options.quality === "high" ? "medium" : void 0;
			body = {
				prompt: text,
				model: GROK_IMAGE_MODEL,
				response_format: "b64_json",
				...references.length > 0 ? { images: references.map((image) => ({
					type: "image_url",
					image_url: toDataUrl(image)
				})) } : {},
				...options.size !== void 0 && aspect[options.size] !== void 0 ? { aspect_ratio: aspect[options.size] } : {},
				...level !== void 0 ? { quality: level } : {}
			};
		}
		const response = await fetch(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
			...options.signal !== void 0 ? { signal: options.signal } : {}
		});
		const payload = await response.json().catch(() => ({}));
		if (!response.ok) {
			const detail = extractErrorMessage(payload);
			throw new Error(`${vendor} HTTP ${String(response.status)}${detail !== void 0 ? `: ${detail.slice(0, 200)}` : ""}`);
		}
		return parseImages(payload);
	}
	/**
	* Resolve (and cache per refresh token) the managed project id the
	* Antigravity generation envelope needs. Re-resolved when the account
	* signs out or a different account logs in.
	*/
	async ensureAntigravityProject(blob) {
		const cacheKey = blob.refreshToken.length > 0 ? blob.refreshToken : blob.accessToken.slice(0, 32);
		const cached = this.projectCache.get(cacheKey);
		if (cached !== void 0) return cached;
		const projectId = await antigravityResolveProject(blob);
		this.projectCache.set(cacheKey, projectId);
		return projectId;
	}
};
/** Map an OpenAI-style size onto the aspect ratio Antigravity accepts. */
function antigravityAspectRatioOf(size) {
	const table = {
		"1024x1024": "1:1",
		"1024x1536": "2:3",
		"1536x1024": "3:2",
		"768x1398": "9:16",
		"1398x768": "16:9",
		auto: "1:1"
	};
	if (size === void 0) return void 0;
	const mapped = table[size];
	if (mapped !== void 0) return mapped;
	return /^\d+:\d+$/.test(size) ? size : "1:1";
}
/** Encode one reference image as the data URL the edit endpoints accept. */
function toDataUrl(image) {
	return `data:${image.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
}
/** Parse OpenRouter's image-capable chat completion response. */
function parseOpenRouterImages(payload) {
	if (typeof payload !== "object" || payload === null) throw new Error("response contains no images");
	const choices = Array.isArray(payload.choices) ? payload.choices : [];
	const images = [];
	for (const choice of choices) {
		if (typeof choice !== "object" || choice === null) continue;
		const message = choice.message;
		if (typeof message !== "object" || message === null) continue;
		const rows = message.images;
		if (!Array.isArray(rows)) continue;
		for (const row of rows) {
			if (typeof row !== "object" || row === null) continue;
			const raw = row.image_url;
			const url = typeof raw === "string" ? raw : typeof raw === "object" && raw !== null && typeof raw.url === "string" ? raw.url : "";
			const match = /^data:([^;]+);base64,(.+)$/s.exec(url);
			if (match?.[2] !== void 0) images.push({ b64_json: match[2] });
		}
	}
	if (images.length === 0) throw new Error("response contains no images");
	return images;
}
/** Response parsing: both vendors reply in the same `{data:[{b64_json}]}` shape. */
function parseImages(payload) {
	const body = typeof payload === "object" && payload !== null ? payload : {};
	const rows = Array.isArray(body.data) ? body.data : [];
	const images = [];
	for (const row of rows) {
		if (typeof row !== "object" || row === null) continue;
		const b64 = row.b64_json;
		if (typeof b64 !== "string" || b64.length === 0) continue;
		const revised = row.revised_prompt;
		images.push({
			b64_json: b64,
			...typeof revised === "string" && revised.length > 0 ? { revisedPrompt: revised } : {}
		});
	}
	if (images.length === 0) throw new Error("response contains no images");
	return images;
}
function extractErrorMessage(payload) {
	if (typeof payload !== "object" || payload === null) return void 0;
	const error = payload.error;
	if (typeof error !== "object" || error === null) return void 0;
	const row = error;
	if (typeof row.message === "string") return row.message;
	if (typeof row.code === "string") return row.code;
}
function notLoggedInError(vendor) {
	const display = providerNameOf(vendor);
	return /* @__PURE__ */ new Error(`${display} 未登录：请到「设置 → 生图配置 → 官方订阅」完成登录`);
}
function escapeHtml(value) {
	return value.replace(/[&<>"']/g, (ch) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		"\"": "&quot;",
		"'": "&#39;"
	})[ch] ?? ch);
}
//#endregion
//#region src/storage-sync.ts
/**
* Object-storage sync for saved images: one S3-compatible uploader (SigV4,
* zero dependencies) that covers Tencent COS / Alibaba OSS / Qiniu S3 /
* MinIO / R2 style endpoints, plus a fire-and-forget hook the image stores
* call after a file lands on disk. The handler is registered by the plugin
* root (it owns the live settings), so framework-free stores stay decoupled
* from the settings seam.
*
* Object keys: `${prefix}/gallery/<file>` and `${prefix}/images/<file>` —
* content-addressed file names dedupe re-uploads naturally.
*/
let uploadHandler;
/** Register the live uploader (index.ts apply). Pass undefined to clear. */
function setStorageSyncHandler(handler) {
	uploadHandler = handler;
}
/** Fire-and-forget notification from the image stores after a file write. */
function notifyImageSaved(kind, filePath) {
	try {
		uploadHandler?.(kind, filePath);
	} catch {}
}
/** URL-encode per RFC 3986 (AWS SigV4 canonical forms). */
function uriEncode(value, encodeSlash = true) {
	return value.replace(/[^A-Za-z0-9-_.~]/g, (char) => {
		return `%${char.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
	}).replace(/%2F/g, encodeSlash ? "%2F" : "/");
}
/** HMAC-SHA256 helper. */
function hmac(key, data) {
	return createHmac("sha256", key).update(data, "utf8").digest();
}
/**
* PUT one object to an S3-compatible endpoint (SigV4, virtual-hosted or
* path-style — the endpoint URL already includes the bucket). Returns the
* elapsed milliseconds so the settings card can show a latency reading.
*/
async function putObject(config, key, data, contentType = "application/octet-stream") {
	const endpoint = config.endpoint.trim().replace(/\/+$/, "");
	if (endpoint === "" || config.accessKey.trim() === "" || config.secretKey.trim() === "") throw new Error("对象存储配置不完整：请填写接口地址与密钥");
	const url = new URL(`${endpoint}/${key.split("/").map((part) => uriEncode(part)).join("/")}`);
	const payloadHash = createHash("sha256").update(data).digest("hex");
	const amzDate = `${(/* @__PURE__ */ new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "")}`;
	const dateStamp = amzDate.slice(0, 8);
	const host = url.host;
	const canonicalUri = url.pathname;
	const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
	const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
	const canonicalRequest = `PUT\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
	const scope = `${dateStamp}/${config.region.trim() || "us-east-1"}/s3/aws4_request`;
	const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${createHash("sha256").update(canonicalRequest, "utf8").digest("hex")}`;
	const signature = createHmac("sha256", hmac(hmac(hmac(hmac(`AWS4${config.secretKey.trim()}`, dateStamp), config.region.trim() || "us-east-1"), "s3"), "aws4_request")).update(stringToSign, "utf8").digest("hex");
	const authorization = `AWS4-HMAC-SHA256 Credential=${config.accessKey.trim()}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
	const started = Date.now();
	const response = await fetch(url, {
		method: "PUT",
		headers: {
			"content-type": contentType,
			"x-amz-content-sha256": payloadHash,
			"x-amz-date": amzDate,
			authorization
		},
		body: new Uint8Array(data)
	});
	if (!response.ok) {
		const text = await response.text().catch(() => "");
		throw new Error(`对象存储拒绝上传（HTTP ${response.status}）${text !== "" ? `：${text.slice(0, 200)}` : ""}`);
	}
	return { ms: Date.now() - started };
}
/** Upload a small probe object; used by the settings card's test button. */
async function testStorage(config) {
	const key = `${config.prefix.trim() || "dsh-imagegen"}/ping.txt`;
	const { ms } = await putObject(config, key, Buffer.from("dsh-imagegen storage ok", "utf8"), "text/plain");
	return {
		ms,
		key
	};
}
//#endregion
//#region src/image-storage-path.ts
const DEFAULT_ROOT = path.join(process.env.DSH_HOME?.trim() || path.join(homedir(), ".dsh"), "dsh-imagegen");
let root = DEFAULT_ROOT;
function imageDataRoot() {
	return root;
}
function setImageDataRoot(value) {
	const trimmed = value?.trim();
	root = trimmed === void 0 || trimmed === "" ? DEFAULT_ROOT : path.resolve(trimmed);
}
//#endregion
//#region src/history-store.ts
/**
* Host-persisted generation history: images are stored as individual files
* under ~/.dsh/dsh-imagegen/images/ and an index.json keeps the metadata +
* file names. This makes the history survive across browsers/devices that
* connect to the same DSH host, and keeps list responses small (the browser
* loads image bytes lazily through the history image route).
*
* Framework-free (node:fs only) so the route layer can drive it directly.
*/
function historyDir() {
	return imageDataRoot();
}
function indexPath$1() {
	return path.join(historyDir(), "index.json");
}
function imagesDir$1() {
	return path.join(historyDir(), "images");
}
let pendingMutation$1 = Promise.resolve();
function mutateHistory(operation) {
	const next = pendingMutation$1.then(operation, operation);
	pendingMutation$1 = next.then(() => void 0, () => void 0);
	return next;
}
/** File extension for a MIME type (image file names). */
function extensionOf$4(mime) {
	switch (mime.split(";")[0].trim()) {
		case "image/jpeg": return "jpg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		default: return "png";
	}
}
/** MIME type for a stored image file name (image route responses). */
function mimeOfFile$2(file) {
	switch (path.extname(file).toLowerCase()) {
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".webp": return "image/webp";
		case ".gif": return "image/gif";
		default: return "image/png";
	}
}
/** Sanitize an entry id for use as a file-name prefix. */
function safeId$2(id) {
	const cleaned = id.replace(/[^a-zA-Z0-9-]/g, "-");
	return cleaned === "" ? "entry" : cleaned;
}
/** Ensure the storage directories exist. */
async function ensureDirs$1() {
	await promises.mkdir(imagesDir$1(), { recursive: true });
}
/** Read the index, tolerating a missing/corrupt file. */
async function readIndex$1() {
	try {
		const raw = await promises.readFile(indexPath$1(), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return [];
		const entries = parsed.entries;
		if (!Array.isArray(entries)) return [];
		return entries.filter(isStoredEntry$1);
	} catch {
		return [];
	}
}
/** Persist the index. */
async function writeIndex$1(entries) {
	await ensureDirs$1();
	const payload = { entries };
	const tmp = `${indexPath$1()}.tmp-${process.pid}`;
	await promises.writeFile(tmp, JSON.stringify(payload), "utf8");
	await promises.rename(tmp, indexPath$1());
}
/** Structural guard for a stored entry. */
function isStoredEntry$1(value) {
	if (value === null || typeof value !== "object") return false;
	const entry = value;
	return typeof entry.id === "string" && typeof entry.createdAt === "number" && (entry.mode === "text" || entry.mode === "edit") && (entry.workflow === void 0 || entry.workflow === "ecommerce") && (entry.projectId === void 0 || typeof entry.projectId === "string") && (entry.projectName === void 0 || typeof entry.projectName === "string") && (entry.slotKey === void 0 || typeof entry.slotKey === "string") && (entry.slotLabel === void 0 || typeof entry.slotLabel === "string") && typeof entry.prompt === "string" && Array.isArray(entry.images) && entry.images.every((image) => {
		if (image === null || typeof image !== "object") return false;
		const record = image;
		return typeof record.file === "string" && typeof record.mime === "string";
	});
}
/** Remove one entry's image files (best effort). */
async function removeEntryFiles$1(entry) {
	for (const image of entry.images) try {
		await promises.rm(path.join(imagesDir$1(), image.file), { force: true });
	} catch {}
}
/** Project a stored entry onto the wire shape (image URLs). */
function toWire$1(entry) {
	return {
		id: entry.id,
		createdAt: entry.createdAt,
		mode: entry.mode,
		model: entry.model,
		prompt: entry.prompt,
		size: entry.size,
		quality: entry.quality,
		detail: entry.detail,
		n: entry.n,
		images: entry.images.map((image) => ({
			url: `/api/dsh-imagegen/history/image/${image.file}`,
			mime: image.mime,
			...image.revisedPrompt === void 0 ? {} : { revisedPrompt: image.revisedPrompt }
		})),
		...entry.refName === void 0 ? {} : { refName: entry.refName },
		...entry.channel === void 0 ? {} : { channel: entry.channel },
		...entry.channelId === void 0 ? {} : { channelId: entry.channelId },
		...entry.comparisonId === void 0 ? {} : { comparisonId: entry.comparisonId },
		...entry.comparisonModels === void 0 ? {} : { comparisonModels: entry.comparisonModels },
		...entry.workflow === void 0 ? {} : { workflow: entry.workflow },
		...entry.projectId === void 0 ? {} : { projectId: entry.projectId },
		...entry.projectName === void 0 ? {} : { projectName: entry.projectName },
		...entry.slotKey === void 0 ? {} : { slotKey: entry.slotKey },
		...entry.slotLabel === void 0 ? {} : { slotLabel: entry.slotLabel },
		...entry.canvas === void 0 ? {} : { canvas: entry.canvas }
	};
}
/** List the persisted history, newest first, as wire entries. */
async function listHistory() {
	return (await readIndex$1()).map(toWire$1);
}
/** Append one generation, evicting the oldest beyond HISTORY_MAX. */
async function appendHistory(input) {
	return mutateHistory(async () => {
		await ensureDirs$1();
		const prefix = safeId$2(input.id);
		const storedImages = [];
		try {
			for (let index = 0; index < input.images.length; index++) {
				const image = input.images[index];
				const file = `${prefix}-${index}.${extensionOf$4(image.mime)}`;
				await promises.writeFile(path.join(imagesDir$1(), file), Buffer.from(image.b64, "base64"));
				notifyImageSaved("history", path.join(imagesDir$1(), file));
				storedImages.push({
					file,
					mime: image.mime,
					...image.revisedPrompt === void 0 ? {} : { revisedPrompt: image.revisedPrompt }
				});
			}
		} catch (error) {
			await removeEntryFiles$1({ images: storedImages });
			throw error;
		}
		const merged = [{
			id: input.id,
			createdAt: input.createdAt,
			mode: input.mode,
			model: input.model,
			prompt: input.prompt,
			size: input.size,
			quality: input.quality,
			detail: input.detail,
			n: input.n,
			images: storedImages,
			...input.refName === void 0 ? {} : { refName: input.refName },
			...input.channelId === void 0 ? {} : { channelId: input.channelId },
			...input.channel === void 0 ? {} : { channel: input.channel },
			...input.comparisonId === void 0 ? {} : { comparisonId: input.comparisonId },
			...input.comparisonModels === void 0 ? {} : { comparisonModels: input.comparisonModels },
			...input.workflow === void 0 ? {} : { workflow: input.workflow },
			...input.projectId === void 0 ? {} : { projectId: input.projectId },
			...input.projectName === void 0 ? {} : { projectName: input.projectName },
			...input.slotKey === void 0 ? {} : { slotKey: input.slotKey },
			...input.slotLabel === void 0 ? {} : { slotLabel: input.slotLabel },
			...input.canvas === void 0 ? {} : { canvas: input.canvas }
		}, ...await readIndex$1()];
		const kept = merged.slice(0, 50);
		for (const dropped of merged.slice(50)) await removeEntryFiles$1(dropped);
		await writeIndex$1(kept);
		return kept.map(toWire$1);
	});
}
/** Remove one entry (and its image files). */
async function removeHistory(id) {
	return mutateHistory(async () => {
		const previous = await readIndex$1();
		const target = previous.find((entry) => entry.id === id);
		if (target !== void 0) await removeEntryFiles$1(target);
		const kept = previous.filter((entry) => entry.id !== id);
		await writeIndex$1(kept);
		return kept.map(toWire$1);
	});
}
/** Remove every entry (and all image files). */
async function clearHistory() {
	return mutateHistory(async () => {
		const previous = await readIndex$1();
		for (const entry of previous) await removeEntryFiles$1(entry);
		await writeIndex$1([]);
		return [];
	});
}
/** Read one stored image file by its (validated) file name. */
async function readHistoryImage(file) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(png|jpg|jpeg|webp|gif)$/.test(file)) return void 0;
	try {
		return {
			data: await promises.readFile(path.join(imagesDir$1(), file)),
			mime: mimeOfFile$2(file)
		};
	} catch {
		return;
	}
}
//#endregion
//#region src/task-queue.ts
/** In-memory, host-resident image generation queue. */
var GenerationTaskQueue = class {
	run;
	concurrency;
	tasks = [];
	controllers = /* @__PURE__ */ new Map();
	listeners = /* @__PURE__ */ new Set();
	running = 0;
	constructor(run, concurrency = 1) {
		this.run = run;
		this.concurrency = concurrency;
	}
	list() {
		return this.tasks.map((task) => this.snapshot(task));
	}
	/**
	* Bounded poll payload: active tasks plus the newest terminal summaries.
	* Image data and completed results are intentionally omitted.
	*/
	summaries(terminalLimit = 100) {
		const limit = Math.max(0, Math.floor(terminalLimit));
		const active = this.tasks.filter((task) => task.status === "queued" || task.status === "running");
		const terminal = this.tasks.filter((task) => task.status !== "queued" && task.status !== "running").slice(0, limit);
		const selected = new Set([...active, ...terminal].map((task) => task.id));
		return this.tasks.filter((task) => selected.has(task.id)).map((task) => this.summary(task));
	}
	get(id) {
		const task = this.tasks.find((item) => item.id === id);
		return task === void 0 ? void 0 : this.snapshot(task);
	}
	/** Observe queue state changes. Listener failures never disrupt generation. */
	subscribe(listener) {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
	submit(request) {
		const task = {
			id: randomUUID(),
			request: { ...request },
			status: "queued",
			createdAt: Date.now()
		};
		this.tasks.unshift(task);
		this.publish(task);
		this.drain();
		return this.snapshot(task);
	}
	cancel(id) {
		const task = this.tasks.find((item) => item.id === id);
		if (task === void 0 || task.status === "completed" || task.status === "failed" || task.status === "cancelled") return task;
		task.status = "cancelled";
		task.finishedAt = Date.now();
		this.controllers.get(id)?.abort();
		this.publish(task);
		this.drain();
		return this.snapshot(task);
	}
	retry(id) {
		const previous = this.tasks.find((item) => item.id === id);
		return previous === void 0 ? void 0 : this.submit(previous.request);
	}
	/** Start queued tasks while capacity remains. Plain submissions and
	* comparison batches alike run in parallel up to the host-wide limit, so one
	* slow upstream can no longer hold back unrelated generations. */
	drain() {
		while (this.running < Math.max(1, this.concurrency)) {
			const task = this.tasks.find((item) => item.status === "queued");
			if (task === void 0) return;
			this.running += 1;
			this.runTask(task).finally(() => {
				this.running -= 1;
				this.drain();
			});
		}
	}
	async runTask(task) {
		task.status = "running";
		task.startedAt = Date.now();
		this.publish(task);
		const controller = new AbortController();
		this.controllers.set(task.id, controller);
		try {
			const result = await this.run(task.request, controller.signal);
			if (this.tasks.find((item) => item.id === task.id)?.status !== "cancelled") {
				task.status = "completed";
				task.result = result;
				task.finishedAt = Date.now();
				this.publish(task);
			}
		} catch (error) {
			if (this.tasks.find((item) => item.id === task.id)?.status !== "cancelled") {
				task.status = "failed";
				task.error = error instanceof Error ? error.message : String(error);
				task.finishedAt = Date.now();
				this.publish(task);
			}
		} finally {
			this.controllers.delete(task.id);
		}
	}
	publish(task) {
		const snapshot = this.snapshot(task);
		for (const listener of this.listeners) try {
			listener(snapshot);
		} catch {}
	}
	summary(task) {
		const request = { ...task.request };
		delete request.image;
		delete request.images;
		return {
			id: task.id,
			request,
			status: task.status,
			createdAt: task.createdAt,
			...task.startedAt === void 0 ? {} : { startedAt: task.startedAt },
			...task.finishedAt === void 0 ? {} : { finishedAt: task.finishedAt },
			...task.error === void 0 ? {} : { error: task.error },
			resultAvailable: task.result !== void 0
		};
	}
	snapshot(task) {
		return {
			...task,
			request: { ...task.request },
			...task.result === void 0 ? {} : { result: task.result }
		};
	}
};
//#endregion
//#region src/generation-runtime.ts
/**
* Shared host-side generation runtime. Both the browser routes and Agent tools
* submit to this one queue so persisted history and cancellation semantics stay
* identical regardless of where a request originated.
*
* Requests carry a channel id (host-filled by the route/tool resolution); the
* runtime picks that channel's upstream credentials, otherwise the default
* channel, and records a channel snapshot on the history entry so usage
* counters and filters survive channel deletion.
*/
var ImageGenerationRuntime = class {
	resolve;
	history;
	subscriptions;
	queue;
	constructor(resolve, history = { append: appendHistory }, subscriptions) {
		this.resolve = resolve;
		this.history = history;
		this.subscriptions = subscriptions;
		this.queue = new GenerationTaskQueue((request, signal) => this.run(request, signal), 4);
	}
	async run(request, signal) {
		const view = this.resolve();
		const channel = view.channels.find((candidate) => candidate.id === request.channelId) ?? view.channels.find((candidate) => candidate.id === view.defaultChannelId) ?? view.channels[0];
		if (channel === void 0) throw new ImageGenError("尚未配置任何渠道：请先打开「设置 → 生图配置」添加渠道并填写 API 地址与密钥", "no-channels");
		const result = channel.auth === "subscription" && channel.subscription !== void 0 ? { images: await this.generateSubscription(channel.subscription, request, signal) } : await generateImage({
			apiUrl: channel.apiUrl,
			apiKey: channel.apiKey,
			apiUrlFull: channel.apiUrlFull,
			protocol: channel.protocol,
			channelName: channel.name
		}, request, { signal });
		try {
			const history = await this.history.append({
				id: randomUUID(),
				createdAt: Date.now(),
				mode: request.mode,
				model: request.model,
				prompt: request.prompt,
				size: request.size,
				quality: request.quality,
				detail: request.detail,
				n: request.n,
				images: result.images,
				...request.refName === void 0 ? {} : { refName: request.refName },
				...request.channelId === void 0 ? {} : { channelId: request.channelId },
				...request.channel === void 0 ? {} : { channel: request.channel },
				...request.comparisonId === void 0 ? {} : { comparisonId: request.comparisonId },
				...request.comparisonModels === void 0 ? {} : { comparisonModels: request.comparisonModels },
				...request.workflow === void 0 ? {} : { workflow: request.workflow },
				...request.projectId === void 0 ? {} : { projectId: request.projectId },
				...request.projectName === void 0 ? {} : { projectName: request.projectName },
				...request.slotKey === void 0 ? {} : { slotKey: request.slotKey },
				...request.slotLabel === void 0 ? {} : { slotLabel: request.slotLabel },
				...request.canvas === void 0 ? {} : { canvas: request.canvas }
			});
			return {
				...result,
				history
			};
		} catch (error) {
			return {
				...result,
				historyError: error instanceof Error ? error.message : String(error)
			};
		}
	}
	/** Generate images through one logged-in subscription account. */
	async generateSubscription(provider, request, signal) {
		if (this.subscriptions === void 0) throw new ImageGenError("当前部署未挂载 DSH Credentials，订阅账号不可用", "subscription-unavailable");
		const references = subscriptionReferences(request);
		const count = Math.max(1, Math.min(4, Math.trunc(request.n) || 1));
		return (await Promise.all(Array.from({ length: count }, async () => await this.subscriptions.generate({
			vendor: vendorOf(provider),
			prompt: request.prompt,
			size: request.size,
			quality: request.quality,
			...references.length > 0 ? { referenceImages: references } : {},
			...signal === void 0 ? {} : { signal }
		})))).flatMap((batch) => batch.flatMap((row) => {
			const mime = detectImageMime(Buffer.from(row.b64_json, "base64"));
			if (mime === void 0) throw new ImageGenError("订阅图像返回了无法识别的图片格式", "subscription-invalid-image");
			return [{
				b64: row.b64_json,
				mime,
				...row.revisedPrompt === void 0 ? {} : { revisedPrompt: row.revisedPrompt }
			}];
		}));
	}
};
/** Decode the request's data-URL references into subscription wire images. */
function subscriptionReferences(request) {
	return [request.image, ...request.images ?? []].filter((value) => typeof value === "string" && value !== "").slice(0, 5).map((value) => {
		const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/su.exec(value);
		if (match === null || match[1] === void 0 || match[2] === void 0) throw new ImageGenError("订阅图生图收到无法解码的参考图片", "subscription-invalid-reference");
		return {
			data: Buffer.from(match[2], "base64"),
			mediaType: match[1]
		};
	});
}
//#endregion
//#region src/gallery-store.ts
/**
* Host-persisted gallery (user-curated favorites): mirrors the history store
* (image files + an index.json under ~/.dsh/dsh-imagegen/gallery/) but with no
* size cap — every entry is an explicit user choice. Appends are deduplicated
* by image content so adding the same generated image twice is a no-op.
*
* Framework-free (node:fs + node:crypto only) so the route layer can drive it
* directly.
*/
function galleryDir() {
	return path.join(imageDataRoot(), "gallery");
}
function indexPath() {
	return path.join(galleryDir(), "index.json");
}
function imagesDir() {
	return path.join(galleryDir(), "images");
}
let pendingMutation = Promise.resolve();
function mutateGallery(operation) {
	const next = pendingMutation.then(operation, operation);
	pendingMutation = next.then(() => void 0, () => void 0);
	return next;
}
/** File extension for a MIME type (image file names). */
function extensionOf$3(mime) {
	switch (mime.split(";")[0].trim()) {
		case "image/jpeg": return "jpg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		default: return "png";
	}
}
/** MIME type for a stored image file name (image route responses). */
function mimeOfFile$1(file) {
	switch (path.extname(file).toLowerCase()) {
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".webp": return "image/webp";
		case ".gif": return "image/gif";
		default: return "image/png";
	}
}
/** Sanitize an entry id for use as a file-name prefix. */
function safeId$1(id) {
	const cleaned = id.replace(/[^a-zA-Z0-9-]/g, "-");
	return cleaned === "" ? "entry" : cleaned;
}
/** Short content fingerprint of the entry's first image. */
function fingerprint(input) {
	const first = input.images[0];
	if (first === void 0) return void 0;
	return createHash("sha1").update(first.b64).digest("hex");
}
/** Ensure the storage directories exist. */
async function ensureDirs() {
	await promises.mkdir(imagesDir(), { recursive: true });
}
/** Read the index, tolerating a missing/corrupt file. */
async function readIndex() {
	try {
		const raw = await promises.readFile(indexPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object") return [];
		const entries = parsed.entries;
		if (!Array.isArray(entries)) return [];
		return entries.filter(isStoredEntry);
	} catch {
		return [];
	}
}
/** Persist the index. */
async function writeIndex(entries) {
	await ensureDirs();
	const payload = { entries };
	const tmp = `${indexPath()}.tmp-${process.pid}`;
	await promises.writeFile(tmp, JSON.stringify(payload), "utf8");
	await promises.rename(tmp, indexPath());
}
/** Structural guard for a stored entry. */
function isStoredEntry(value) {
	if (value === null || typeof value !== "object") return false;
	const entry = value;
	return typeof entry.id === "string" && typeof entry.createdAt === "number" && (entry.mode === "text" || entry.mode === "edit") && (entry.workflow === void 0 || entry.workflow === "ecommerce") && (entry.projectId === void 0 || typeof entry.projectId === "string") && (entry.projectName === void 0 || typeof entry.projectName === "string") && (entry.slotKey === void 0 || typeof entry.slotKey === "string") && (entry.slotLabel === void 0 || typeof entry.slotLabel === "string") && typeof entry.prompt === "string" && Array.isArray(entry.images) && entry.images.every((image) => {
		if (image === null || typeof image !== "object") return false;
		const record = image;
		return typeof record.file === "string" && typeof record.mime === "string";
	});
}
/** Remove one entry's image files (best effort). */
async function removeEntryFiles(entry) {
	for (const image of entry.images) try {
		await promises.rm(path.join(imagesDir(), image.file), { force: true });
	} catch {}
}
/** Project a stored entry onto the wire shape (image URLs). */
function toWire(entry) {
	return {
		id: entry.id,
		createdAt: entry.createdAt,
		mode: entry.mode,
		model: entry.model,
		prompt: entry.prompt,
		size: entry.size,
		quality: entry.quality,
		detail: entry.detail,
		n: entry.n,
		images: entry.images.map((image) => ({
			url: `/api/dsh-imagegen/gallery/image/${image.file}`,
			mime: image.mime,
			...image.revisedPrompt === void 0 ? {} : { revisedPrompt: image.revisedPrompt }
		})),
		...entry.refName === void 0 ? {} : { refName: entry.refName },
		...entry.tags === void 0 ? {} : { tags: entry.tags },
		...entry.channel === void 0 ? {} : { channel: entry.channel },
		...entry.channelId === void 0 ? {} : { channelId: entry.channelId },
		...entry.workflow === void 0 ? {} : { workflow: entry.workflow },
		...entry.projectId === void 0 ? {} : { projectId: entry.projectId },
		...entry.projectName === void 0 ? {} : { projectName: entry.projectName },
		...entry.slotKey === void 0 ? {} : { slotKey: entry.slotKey },
		...entry.slotLabel === void 0 ? {} : { slotLabel: entry.slotLabel },
		...entry.canvas === void 0 ? {} : { canvas: entry.canvas }
	};
}
/** List the persisted gallery, newest first, as wire entries. */
async function listGallery() {
	return (await readIndex()).map(toWire);
}
/** Append one image to the gallery. Deduplicates by first-image content —
*  appending an image already in the gallery returns `added: false` with the
*  list unchanged. No size cap: every entry is an explicit user choice. */
async function appendGallery(input) {
	return mutateGallery(async () => {
		await ensureDirs();
		const hash = fingerprint(input);
		if (hash !== void 0) {
			const existing = await readIndex();
			if (existing.some((entry) => entry.hash === hash)) return {
				entries: existing.map(toWire),
				added: false
			};
		}
		const prefix = safeId$1(input.id);
		const storedImages = [];
		try {
			for (let index = 0; index < input.images.length; index++) {
				const image = input.images[index];
				const file = `${prefix}-${index}.${extensionOf$3(image.mime)}`;
				await promises.writeFile(path.join(imagesDir(), file), Buffer.from(image.b64, "base64"));
				notifyImageSaved("gallery", path.join(imagesDir(), file));
				storedImages.push({
					file,
					mime: image.mime,
					...image.revisedPrompt === void 0 ? {} : { revisedPrompt: image.revisedPrompt }
				});
			}
		} catch (error) {
			await removeEntryFiles({ images: storedImages });
			throw error;
		}
		const merged = [{
			id: input.id,
			createdAt: input.createdAt,
			mode: input.mode,
			model: input.model,
			prompt: input.prompt,
			size: input.size,
			quality: input.quality,
			detail: input.detail,
			n: input.n,
			images: storedImages,
			...hash === void 0 ? {} : { hash },
			...input.refName === void 0 ? {} : { refName: input.refName },
			...input.channelId === void 0 ? {} : { channelId: input.channelId },
			...input.channel === void 0 ? {} : { channel: input.channel },
			...input.workflow === void 0 ? {} : { workflow: input.workflow },
			...input.projectId === void 0 ? {} : { projectId: input.projectId },
			...input.projectName === void 0 ? {} : { projectName: input.projectName },
			...input.slotKey === void 0 ? {} : { slotKey: input.slotKey },
			...input.slotLabel === void 0 ? {} : { slotLabel: input.slotLabel },
			...input.canvas === void 0 ? {} : { canvas: input.canvas }
		}, ...await readIndex()];
		await writeIndex(merged);
		return {
			entries: merged.map(toWire),
			added: true
		};
	});
}
/** Remove one entry (and its image files). */
async function removeGallery(id) {
	return mutateGallery(async () => {
		const previous = await readIndex();
		const target = previous.find((entry) => entry.id === id);
		if (target !== void 0) await removeEntryFiles(target);
		const kept = previous.filter((entry) => entry.id !== id);
		await writeIndex(kept);
		return kept.map(toWire);
	});
}
/** Replace the user-managed labels for one gallery entry. */
async function updateGalleryTags(id, tags) {
	return mutateGallery(async () => {
		const normalized = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))].slice(0, 20);
		const entries = await readIndex();
		const target = entries.find((entry) => entry.id === id);
		if (target !== void 0) target.tags = normalized;
		await writeIndex(entries);
		return entries.map(toWire);
	});
}
/** Remove every entry (and all image files). */
async function clearGallery() {
	return mutateGallery(async () => {
		const previous = await readIndex();
		for (const entry of previous) await removeEntryFiles(entry);
		await writeIndex([]);
		return [];
	});
}
/** Read one stored image file by its (validated) file name. */
async function readGalleryImage(file) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9-]*-[0-9]+\.(png|jpg|jpeg|webp|gif)$/.test(file)) return void 0;
	try {
		return {
			data: await promises.readFile(path.join(imagesDir(), file)),
			mime: mimeOfFile$1(file)
		};
	} catch {
		return;
	}
}
//#endregion
//#region src/canvas-store.ts
/** Host-persisted infinite canvas documents and content-addressed assets. */
/** Cap on one canvas file asset (arbitrary types travel as raw bytes). */
const MAX_CANVAS_FILE_BYTES = 50 * 1024 * 1024;
/** Text previews kept inline on the asset ref so the node can render without a fetch. */
const MAX_FILE_TEXT_PREVIEW = 8 * 1024;
/** Extensions that must never round-trip through the canvas asset store: they
*  are the classic self-executing downloads. The client blocks them too; this
*  is the host-side half of the same rule. */
const BLOCKED_FILE_EXTENSIONS = /* @__PURE__ */ new Set([
	"exe",
	"com",
	"scr",
	"pif",
	"cpl",
	"msi",
	"msp",
	"dll",
	"sys",
	"bat",
	"cmd",
	"ps1",
	"psm1",
	"vbs",
	"vbe",
	"js",
	"mjs",
	"cjs",
	"jse",
	"wsf",
	"wsh",
	"hta",
	"jar",
	"apk",
	"app",
	"sh",
	"bash",
	"command",
	"reg",
	"lnk",
	"url",
	"html",
	"htm",
	"xhtml",
	"svg"
]);
/** MIME types accepted for arbitrary files (images keep their own strict path). */
const FILE_MIME_ALLOW = /^(application\/(pdf|json|zip|x-zip-compressed|vnd\.openxmlformats-officedocument\.[a-z0-9.+-]+|vnd\.ms-(excel|powerpoint|word)\.[a-z0-9.+-]+|vnd\.oasis\.opendocument\.[a-z0-9.+-]+|rtf|xml|javascript|typescript|x-yaml|yaml|x-sh|x-httpd-php|epub\+zip|gzip|x-7z-compressed|x-rar-compressed|x-tar|octet-stream)|text\/[a-z0-9.+-]+|image\/(png|jpeg|webp|gif|bmp|tiff)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;
/** Extension used for each accepted MIME type; unknown types become `.bin`. */
const EXTENSION_BY_MIME = {
	"application/pdf": "pdf",
	"application/json": "json",
	"application/zip": "zip",
	"application/x-zip-compressed": "zip",
	"application/rtf": "rtf",
	"application/xml": "xml",
	"application/x-yaml": "yaml",
	"application/yaml": "yaml",
	"application/javascript": "js",
	"application/typescript": "ts",
	"application/epub+zip": "epub",
	"application/gzip": "gz",
	"application/x-7z-compressed": "7z",
	"application/x-rar-compressed": "rar",
	"application/x-tar": "tar",
	"application/vnd.ms-excel": "xls",
	"application/vnd.ms-powerpoint": "ppt",
	"application/vnd.ms-word": "doc",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
	"application/vnd.openxmlformats-officedocument.presentationml.slideshow": "ppsx",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
	"application/vnd.oasis.opendocument.text": "odt",
	"application/vnd.oasis.opendocument.presentation": "odp",
	"application/vnd.oasis.opendocument.spreadsheet": "ods",
	"text/plain": "txt",
	"text/markdown": "md",
	"text/csv": "csv",
	"text/html": "html",
	"text/xml": "xml",
	"text/yaml": "yaml",
	"text/x-python": "py",
	"image/png": "png",
	"image/jpeg": "jpg",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/bmp": "bmp",
	"image/tiff": "tiff",
	"audio/mpeg": "mp3",
	"audio/wav": "wav",
	"audio/ogg": "ogg",
	"audio/mp4": "m4a",
	"video/mp4": "mp4",
	"video/webm": "webm",
	"video/quicktime": "mov"
};
const MIME_BY_EXTENSION = {
	pdf: "application/pdf",
	json: "application/json",
	zip: "application/zip",
	rtf: "application/rtf",
	xml: "application/xml",
	yaml: "application/x-yaml",
	yml: "application/x-yaml",
	txt: "text/plain",
	log: "text/plain",
	md: "text/markdown",
	markdown: "text/markdown",
	csv: "text/csv",
	tsv: "text/tab-separated-values",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	doc: "application/vnd.ms-word",
	xls: "application/vnd.ms-excel",
	odt: "application/vnd.oasis.opendocument.text",
	odp: "application/vnd.oasis.opendocument.presentation",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	bmp: "image/bmp",
	tiff: "image/tiff",
	tif: "image/tiff",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	mp4: "video/mp4",
	webm: "video/webm"
};
/** Content-addressed names may carry any short, safe extension (see putFile). */
const ASSET_FILE_NAME = /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/;
function extensionOf$2(mime) {
	switch (mime.split(";")[0].trim().toLowerCase()) {
		case "image/jpeg": return "jpg";
		case "image/webp": return "webp";
		case "image/gif": return "gif";
		default: return "png";
	}
}
/** MIME type without its parameters, lower-cased (`text/plain; charset=utf-8`). */
function baseMime$1(mime) {
	return mime.split(";")[0].trim().toLowerCase();
}
/** Whether a MIME type carries readable text (used for inline previews). */
function isTextMime(mime) {
	const value = baseMime$1(mime);
	return value.startsWith("text/") || value === "application/json" || value === "application/xml" || value === "application/x-yaml" || value === "application/yaml" || value === "application/javascript" || value === "application/typescript";
}
/** MIME type inferred from a file name, used when the browser reports none. */
function mimeFromFileName(name) {
	const extension = path.extname(name).replace(/^\./, "").toLowerCase();
	return MIME_BY_EXTENSION[extension] ?? "";
}
/** Whether one file name may enter the canvas store at all. */
function isBlockedFileName(name) {
	const extension = path.extname(name).replace(/^\./, "").toLowerCase();
	return extension !== "" && BLOCKED_FILE_EXTENSIONS.has(extension);
}
/** Strip directories, control characters and pathological lengths. */
function safeFileName(value) {
	const cleaned = (value.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
	if (cleaned === "" || cleaned === "." || cleaned === "..") return "file";
	return cleaned.length > 120 ? cleaned.slice(0, 120) : cleaned;
}
/** Coarse bucket driving the file node's icon and preview branch. */
function fileKindOf(mime, name = "") {
	const value = baseMime$1(mime);
	const extension = path.extname(name).replace(/^\./, "").toLowerCase();
	if (value === "application/pdf" || extension === "pdf") return "pdf";
	if (value.startsWith("image/")) return "image";
	if (value.startsWith("audio/")) return "audio";
	if (value.startsWith("video/")) return "video";
	if (value === "application/zip" || value === "application/x-zip-compressed" || value.startsWith("application/x-7z") || value.startsWith("application/x-rar") || value === "application/gzip" || value === "application/x-tar" || [
		"zip",
		"7z",
		"rar",
		"gz",
		"tar"
	].includes(extension)) return "archive";
	if (value.includes("openxmlformats") || value.startsWith("application/vnd.ms-") || value.startsWith("application/vnd.oasis") || [
		"pptx",
		"docx",
		"xlsx",
		"ppt",
		"doc",
		"xls",
		"odt",
		"odp",
		"ods"
	].includes(extension)) return "office";
	if (isTextMime(value) || [
		"md",
		"markdown",
		"csv",
		"tsv",
		"log",
		"json",
		"yaml",
		"yml",
		"xml",
		"txt"
	].includes(extension)) return "text";
	return "other";
}
/** Decoded head of a text file, bounded and safe against a split multi-byte
*  character at the cut point (TextDecoder drops a trailing partial sequence). */
function textHead(data) {
	const slice = data.byteLength > 8192 ? data.subarray(0, MAX_FILE_TEXT_PREVIEW) : data;
	try {
		const text = new TextDecoder("utf-8", { fatal: false }).decode(slice);
		return text.includes("\0") ? void 0 : text;
	} catch {
		return;
	}
}
var CanvasConflictError = class extends Error {
	code = "canvas-conflict";
	constructor(message = "画布已在其他窗口更新，请重新加载后再保存。") {
		super(message);
		this.name = "CanvasConflictError";
	}
};
/** MIME type of one stored asset, derived from its content-addressed name. */
function mimeOf(file) {
	const extension = path.extname(file).replace(/^\./, "").toLowerCase();
	if (MIME_BY_EXTENSION[extension] !== void 0) return MIME_BY_EXTENSION[extension];
	switch (extension) {
		case "jpg":
		case "jpeg": return "image/jpeg";
		case "webp": return "image/webp";
		case "gif": return "image/gif";
		case "js": return "application/javascript";
		case "ts": return "application/typescript";
		case "bin": return "application/octet-stream";
		default: return "application/octet-stream";
	}
}
function safeId(value) {
	const id = value.replace(/[^a-zA-Z0-9_-]/g, "-");
	return id === "" ? randomUUID() : id;
}
async function writeJsonAtomic(file, value) {
	await promises.mkdir(path.dirname(file), { recursive: true });
	const temp = `${file}.tmp-${process.pid}-${randomUUID()}`;
	await promises.writeFile(temp, `${JSON.stringify(value)}\n`, "utf8");
	await promises.rename(temp, file);
}
async function readJson(file) {
	try {
		return JSON.parse(await promises.readFile(file, "utf8"));
	} catch {
		return;
	}
}
function defaultDocument(id, title) {
	const now = Date.now();
	return {
		version: 2,
		id,
		title,
		revision: 1,
		viewport: {
			x: 0,
			y: 0,
			k: 1
		},
		background: "lines",
		nodes: [],
		connections: [],
		createdAt: now,
		updatedAt: now
	};
}
function isAssetRef(value) {
	if (value === null || typeof value !== "object") return false;
	const asset = value;
	if (typeof asset.assetId !== "string" || typeof asset.url !== "string" || typeof asset.mime !== "string") return false;
	const file = asset.kind === "file";
	if (typeof asset.width !== "number" || typeof asset.height !== "number") return false;
	if (!file && (asset.width < 1 || asset.height < 1)) return false;
	if (asset.kind !== void 0 && asset.kind !== "image" && asset.kind !== "file") return false;
	if (asset.name !== void 0 && typeof asset.name !== "string") return false;
	if (asset.textPreview !== void 0 && typeof asset.textPreview !== "string") return false;
	return true;
}
function isNode(value) {
	if (value === null || typeof value !== "object") return false;
	const node = value;
	if (typeof node.id !== "string" || typeof node.title !== "string" || typeof node.x !== "number" || typeof node.y !== "number" || typeof node.width !== "number" || typeof node.height !== "number") return false;
	if (node.type !== "image" && node.type !== "text" && node.type !== "file" && node.type !== "config") return false;
	const metadata = node.metadata;
	if (metadata !== void 0 && (metadata === null || typeof metadata !== "object")) return false;
	const state = metadata ?? {};
	if (node.type === "image") {
		if (state.asset !== void 0 && !isAssetRef(state.asset)) return false;
		return state.status === void 0 || state.status === "idle" || state.status === "generating" || state.status === "success" || state.status === "error";
	}
	if (node.type === "file") return state.asset === void 0 || isAssetRef(state.asset);
	if (node.type === "config") return state.prompt === void 0 || typeof state.prompt === "string";
	return state.text === void 0 || typeof state.text === "string";
}
function isDocument(value) {
	if (value === null || typeof value !== "object") return false;
	const document = value;
	return document.version === 2 && typeof document.id === "string" && typeof document.title === "string" && typeof document.revision === "number" && document.viewport !== null && typeof document.viewport === "object" && typeof document.viewport.x === "number" && typeof document.viewport.y === "number" && typeof document.viewport.k === "number" && (document.background === "dots" || document.background === "lines" || document.background === "blank" || document.background === "image" || document.background === "flow" || document.background === "liquid" || document.background === "floatingLines" || document.background === "galaxy" || document.background === "silk" || document.background === "waves" || document.background === "faultyTerminal" || document.background === "dotField" || document.background === "dotGrid" || document.background === "shapeGrid") && (document.backgroundImage === void 0 || typeof document.backgroundImage === "string") && Array.isArray(document.nodes) && document.nodes.every(isNode) && Array.isArray(document.connections);
}
/** Upgrade a v1 (image/text/annotation + edges) document to the v2 node-graph model.
* Images and text notes keep their geometry; annotation prompt cards become plain
* text notes carrying the prompt, and old edges survive only between surviving nodes. */
function migrateLegacyDocument(input) {
	const now = Date.now();
	const legacyNodes = Array.isArray(input.nodes) ? input.nodes : [];
	const nodes = [];
	const annotationIds = /* @__PURE__ */ new Set();
	for (const raw of legacyNodes) {
		if (raw === null || typeof raw !== "object") continue;
		const node = raw;
		if (typeof node.id !== "string" || typeof node.x !== "number" || typeof node.y !== "number") continue;
		const base = {
			id: node.id,
			title: typeof node.title === "string" ? node.title : "未命名节点",
			x: node.x,
			y: node.y,
			width: typeof node.width === "number" ? node.width : 300,
			height: typeof node.height === "number" ? node.height : 220
		};
		if (node.type === "image" && isAssetRef(node.asset)) {
			const generation = node.generation ?? {};
			nodes.push({
				...base,
				type: "image",
				metadata: {
					asset: node.asset,
					status: typeof node.status === "string" && [
						"idle",
						"generating",
						"success",
						"error"
					].includes(node.status) ? node.status : "success",
					...typeof node.error === "string" ? { error: node.error } : {},
					...typeof generation.prompt === "string" ? { prompt: generation.prompt } : {},
					...typeof generation.model === "string" ? { model: generation.model } : {},
					...typeof generation.taskId === "string" ? { taskId: generation.taskId } : {},
					...typeof generation.sourceNodeId === "string" ? { sourceNodeId: generation.sourceNodeId } : {}
				}
			});
		} else if (node.type === "text") nodes.push({
			...base,
			type: "text",
			metadata: {
				text: typeof node.text === "string" ? node.text : "",
				...typeof node.fontSize === "number" ? { fontSize: node.fontSize } : {}
			}
		});
		else if (node.type === "annotation") {
			annotationIds.add(node.id);
			const prompt = typeof node.prompt === "string" && node.prompt.trim() !== "" ? node.prompt : "（旧版标注，提示词见此）";
			nodes.push({
				...base,
				type: "text",
				title: "旧版标注",
				metadata: { text: prompt }
			});
		}
	}
	nodes.sort((a, b) => {
		const za = legacyNodes.find((item) => item?.id === a.id)?.zIndex;
		const zb = legacyNodes.find((item) => item?.id === b.id)?.zIndex;
		return (typeof za === "number" ? za : 0) - (typeof zb === "number" ? zb : 0);
	});
	const validIds = new Set(nodes.map((node) => node.id));
	const seen = /* @__PURE__ */ new Set();
	const connections = (Array.isArray(input.edges) ? input.edges : []).flatMap((raw) => {
		if (raw === null || typeof raw !== "object") return [];
		const edge = raw;
		if (typeof edge.fromNodeId !== "string" || typeof edge.toNodeId !== "string") return [];
		if (annotationIds.has(edge.fromNodeId) || annotationIds.has(edge.toNodeId)) return [];
		if (!validIds.has(edge.fromNodeId) || !validIds.has(edge.toNodeId) || edge.fromNodeId === edge.toNodeId) return [];
		const key = `${edge.fromNodeId}->${edge.toNodeId}`;
		if (seen.has(key)) return [];
		seen.add(key);
		return [{
			id: typeof edge.id === "string" ? edge.id : `edge-${randomUUID()}`,
			fromNodeId: edge.fromNodeId,
			toNodeId: edge.toNodeId
		}];
	});
	const legacyViewport = input.viewport ?? {};
	const background = input.background === "grid" ? "lines" : input.background === "blank" ? "blank" : "dots";
	return {
		version: 2,
		id: typeof input.id === "string" ? input.id : randomUUID(),
		title: typeof input.title === "string" ? input.title : "未命名画布",
		revision: typeof input.revision === "number" ? input.revision : 1,
		viewport: {
			x: typeof legacyViewport.x === "number" ? legacyViewport.x : 0,
			y: typeof legacyViewport.y === "number" ? legacyViewport.y : 0,
			k: typeof legacyViewport.scale === "number" && legacyViewport.scale > 0 ? legacyViewport.scale : 1
		},
		background,
		nodes,
		connections,
		createdAt: typeof input.createdAt === "number" ? input.createdAt : now,
		updatedAt: typeof input.updatedAt === "number" ? input.updatedAt : now
	};
}
/** Background modes removed from the picker still show up in older saved
*  documents; map them to their nearest surviving replacement. */
const REMOVED_BACKGROUND_FALLBACK = {
	diagonal: "lines",
	checker: "dots",
	aurora: "liquid"
};
/** Accept either the v2 document or a legacy v1 payload and return v2. */
function coerceDocument(value) {
	if (value === null || typeof value !== "object") return void 0;
	const document = value;
	if (document.version === 1) {
		const migrated = migrateLegacyDocument(document);
		return isDocument(migrated) ? migrated : void 0;
	}
	const fallback = REMOVED_BACKGROUND_FALLBACK[String(document.background)];
	if (fallback !== void 0) return isDocument({
		...document,
		background: fallback
	}) ? {
		...document,
		background: fallback
	} : void 0;
	return isDocument(value) ? value : void 0;
}
let mutation = Promise.resolve();
function serialize(operation) {
	const next = mutation.then(operation, operation);
	mutation = next.then(() => void 0, () => void 0);
	return next;
}
var CanvasStore = class {
	root;
	constructor(root) {
		this.root = root;
	}
	pagesDir() {
		return path.join(this.root ?? path.join(imageDataRoot(), "canvas"), "pages");
	}
	assetsDir() {
		return path.join(this.root ?? path.join(imageDataRoot(), "canvas"), "assets");
	}
	indexPath() {
		return path.join(this.root ?? path.join(imageDataRoot(), "canvas"), "index.json");
	}
	async ensure() {
		await promises.mkdir(this.pagesDir(), { recursive: true });
		await promises.mkdir(this.assetsDir(), { recursive: true });
	}
	pagePath(id) {
		return path.join(this.pagesDir(), `${safeId(id)}.json`);
	}
	assetPath(id) {
		if (!ASSET_FILE_NAME.test(id)) return void 0;
		const target = path.join(this.assetsDir(), id);
		const relative = path.relative(this.assetsDir(), target);
		return relative.startsWith("..") || path.isAbsolute(relative) ? void 0 : target;
	}
	async readIndex() {
		const value = await readJson(this.indexPath());
		if (value === void 0 || typeof value !== "object" || !Array.isArray(value.projects)) return [];
		return value.projects.flatMap((item) => {
			if (item === null || typeof item !== "object") return [];
			const project = item;
			if (!(typeof project.id === "string" && typeof project.title === "string" && typeof project.revision === "number" && typeof project.nodeCount === "number" && typeof project.createdAt === "number" && typeof project.updatedAt === "number")) return [];
			return [{
				id: project.id,
				title: project.title,
				revision: project.revision,
				nodeCount: project.nodeCount,
				createdAt: project.createdAt,
				updatedAt: project.updatedAt,
				...project.favorite === true ? { favorite: true } : {}
			}];
		});
	}
	async writeIndex(projects) {
		await this.ensure();
		await writeJsonAtomic(this.indexPath(), { projects });
	}
	async list() {
		return this.readIndex();
	}
	async create(title = "未命名画布") {
		return serialize(async () => {
			await this.ensure();
			const id = randomUUID();
			const document = defaultDocument(id, title.trim() || "未命名画布");
			await writeJsonAtomic(this.pagePath(id), document);
			const projects = await this.readIndex();
			await this.writeIndex([this.summaryOf(document), ...projects]);
			return document;
		});
	}
	async read(id) {
		return coerceDocument(await readJson(this.pagePath(id)));
	}
	async save(document, expectedRevision) {
		return serialize(async () => {
			const incoming = coerceDocument(document);
			if (incoming === void 0) throw new Error("malformed canvas document");
			const current = await this.read(incoming.id);
			if (current !== void 0 && expectedRevision !== void 0 && current.revision !== expectedRevision) throw new CanvasConflictError();
			const next = {
				...incoming,
				revision: Math.max(current?.revision ?? 0, incoming.revision) + 1,
				updatedAt: Date.now()
			};
			await this.ensure();
			await writeJsonAtomic(this.pagePath(next.id), next);
			const projects = await this.readIndex();
			const favorite = projects.find((item) => item.id === next.id)?.favorite === true;
			await this.writeIndex([this.summaryOf(next, favorite), ...projects.filter((item) => item.id !== next.id)]);
			return next;
		});
	}
	async setFavorite(id, favorite) {
		return serialize(async () => {
			const projects = await this.readIndex();
			if (!projects.some((item) => item.id === id)) throw new Error("画布不存在");
			const next = projects.map((item) => item.id === id ? {
				...item,
				...favorite ? { favorite: true } : { favorite: void 0 }
			} : item);
			await this.writeIndex(next);
			return next;
		});
	}
	async remove(id) {
		return serialize(async () => {
			try {
				await promises.rm(this.pagePath(id), { force: true });
			} catch {}
			const projects = (await this.readIndex()).filter((item) => item.id !== id);
			await this.writeIndex(projects);
			return projects;
		});
	}
	/** Store raw bytes under their content hash and return the node-facing ref. */
	async putAsset(input) {
		await this.ensure();
		const file = `${createHash("sha256").update(input.data).digest("hex")}.${input.extension}`;
		const target = path.join(this.assetsDir(), file);
		try {
			await promises.access(target);
		} catch {
			await promises.writeFile(target, input.data);
		}
		return {
			assetId: file,
			url: `/api/dsh-imagegen/canvas/asset/${file}`,
			mime: input.mime,
			bytes: input.data.byteLength,
			...input.ref
		};
	}
	async putImage(input) {
		if (!input.data.byteLength) throw new Error("image data is empty");
		if (!/^image\/(png|jpeg|webp|gif)$/.test(input.mime)) throw new Error("unsupported image type");
		if (!Number.isSafeInteger(input.width) || input.width < 1 || !Number.isSafeInteger(input.height) || input.height < 1) throw new Error("image dimensions are invalid");
		return this.putAsset({
			data: input.data,
			mime: input.mime,
			extension: extensionOf$2(input.mime),
			ref: {
				width: input.width,
				height: input.height,
				kind: "image",
				origin: input.origin,
				...input.name === void 0 ? {} : { name: safeFileName(input.name) },
				...input.originId === void 0 ? {} : { originId: input.originId },
				...input.entryId === void 0 ? {} : { entryId: input.entryId },
				...input.imageIndex === void 0 ? {} : { imageIndex: input.imageIndex }
			}
		});
	}
	/**
	* Store one arbitrary file (the canvas file node's upload path). Executable
	* and script-shaped extensions are refused here as well as in the browser:
	* the asset route serves non-image types as attachments, and this keeps a
	* hand-crafted request from parking one on disk in the first place.
	*/
	async putFile(input) {
		if (!input.data.byteLength) throw new Error("file data is empty");
		if (input.data.byteLength > 52428800) throw new Error(`文件超过 ${Math.round(MAX_CANVAS_FILE_BYTES / (1024 * 1024))}MB 上限`);
		const name = safeFileName(input.name);
		if (isBlockedFileName(name)) throw new Error(`出于安全考虑，不支持上传 ${path.extname(name)} 文件`);
		const declared = baseMime$1(input.mime);
		const inferred = mimeFromFileName(name);
		const mime = declared !== "" && declared !== "application/octet-stream" ? declared : inferred !== "" ? inferred : "application/octet-stream";
		if (!FILE_MIME_ALLOW.test(mime)) throw new Error(`不支持的文件类型：${mime}`);
		const extension = EXTENSION_BY_MIME[mime] ?? (path.extname(name).replace(/^\./, "").toLowerCase() || "bin");
		const textPreview = isTextMime(mime) ? textHead(input.data) : void 0;
		return this.putAsset({
			data: input.data,
			mime,
			extension,
			ref: {
				width: 0,
				height: 0,
				kind: "file",
				name,
				origin: input.origin,
				...input.originId === void 0 ? {} : { originId: input.originId },
				...textPreview === void 0 ? {} : { textPreview }
			}
		});
	}
	async readAsset(file) {
		const target = this.assetPath(file);
		if (target === void 0) return void 0;
		try {
			return {
				data: await promises.readFile(target),
				mime: mimeOf(file)
			};
		} catch {
			return;
		}
	}
	/** Read several assets at once, keyed by asset id (missing entries omitted). */
	async readAssets(refs) {
		const out = /* @__PURE__ */ new Map();
		for (const ref of refs) {
			if (ref.assetId === "" || out.has(ref.assetId)) continue;
			const found = await this.readAsset(ref.assetId);
			if (found !== void 0) out.set(ref.assetId, found);
		}
		return out;
	}
	/** Copy one asset out of the content-addressed store into a real file path,
	*  so a skill run (or a headless agent) can read it as an ordinary file. */
	async materialize(ref, targetPath) {
		const found = await this.readAsset(ref.assetId);
		if (found === void 0) throw new Error(`画布资产不存在：${ref.assetId}`);
		await promises.mkdir(path.dirname(targetPath), { recursive: true });
		await promises.writeFile(targetPath, found.data);
	}
	summaryOf(document, favorite = false) {
		return {
			id: document.id,
			title: document.title,
			revision: document.revision,
			nodeCount: document.nodes.length,
			createdAt: document.createdAt,
			updatedAt: document.updatedAt,
			...favorite ? { favorite: true } : {}
		};
	}
};
const canvasStore = new CanvasStore();
//#endregion
//#region src/zip.ts
/**
* Dependency-free ZIP reading.
*
* Skills arrive as archives (GitHub source zips, hand-made bundles) and OOXML
* documents are ZIP containers, so both the skill library and the text
* extractor need to walk a central directory and inflate entries. Doing it with
* `node:zlib` keeps the plugin free of native dependencies.
*
* Only the *reading* path is implemented, and every read is bounded: an entry
* is skipped when its header lies outside the buffer or when its declared size
* exceeds the caller's cap, so a hostile archive cannot make the host allocate
* unbounded memory.
*/
/** Maximum number of entries inspected in one archive. */
const MAX_ZIP_ENTRIES = 2e3;
/** Read a ZIP central directory. Returns an empty list for a non-ZIP buffer. */
function readZipDirectory(data) {
	const maxScan = Math.min(data.length, 66e3);
	let eocd = -1;
	for (let offset = data.length - 22; offset >= data.length - maxScan && offset >= 0; offset -= 1) if (data.readUInt32LE(offset) === 101010256) {
		eocd = offset;
		break;
	}
	if (eocd < 0) return [];
	const count = Math.min(data.readUInt16LE(eocd + 10), MAX_ZIP_ENTRIES);
	let cursor = data.readUInt32LE(eocd + 16);
	const entries = [];
	for (let index = 0; index < count && cursor + 46 <= data.length; index += 1) {
		if (data.readUInt32LE(cursor) !== 33639248) break;
		const method = data.readUInt16LE(cursor + 10);
		const compressedSize = data.readUInt32LE(cursor + 20);
		const uncompressedSize = data.readUInt32LE(cursor + 24);
		const nameLength = data.readUInt16LE(cursor + 28);
		const extraLength = data.readUInt16LE(cursor + 30);
		const commentLength = data.readUInt16LE(cursor + 32);
		const mode = data.readUInt32LE(cursor + 38) >>> 16;
		const localHeaderOffset = data.readUInt32LE(cursor + 42);
		const name = data.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");
		entries.push({
			name,
			method,
			uncompressedSize,
			compressedSize,
			localHeaderOffset,
			mode
		});
		cursor += 46 + nameLength + extraLength + commentLength;
	}
	return entries;
}
/**
* Inflate one entry.
* @param data - the whole archive.
* @param entry - an entry from {@link readZipDirectory}.
* @param maxBytes - refuse entries larger than this (uncompressed).
* @returns the entry bytes, or undefined when it cannot be read safely.
*/
function readZipEntry(data, entry, maxBytes = 8 * 1024 * 1024) {
	if (entry.uncompressedSize > maxBytes) return void 0;
	const header = entry.localHeaderOffset;
	if (header + 30 > data.length || data.readUInt32LE(header) !== 67324752) return void 0;
	const nameLength = data.readUInt16LE(header + 26);
	const extraLength = data.readUInt16LE(header + 28);
	const start = header + 30 + nameLength + extraLength;
	const end = entry.compressedSize === 0 ? data.length : Math.min(data.length, start + entry.compressedSize);
	if (start > data.length || end < start) return void 0;
	const raw = data.subarray(start, end);
	try {
		if (entry.method === 0) {
			if (raw.length > maxBytes) return void 0;
			return Buffer.from(raw);
		}
		if (entry.method === 8) return inflateRawSync(raw, { maxOutputLength: maxBytes });
	} catch {
		return;
	}
}
/** Whether a directory entry name looks like a folder marker. */
function isZipDirectory(entry) {
	return entry.name.endsWith("/") || (entry.mode & 61440) === 16384;
}
//#endregion
//#region src/file-text.ts
/**
* Best-effort plain-text extraction for canvas file nodes.
*
* The light skill tier sends text to a chat model, so a file node needs *some*
* readable text before it can be processed at all. This module covers the
* formats that are genuinely extractable without native dependencies:
*
*  - text-like files (txt / md / csv / json / code) decode directly;
*  - OOXML and ODF documents (docx / pptx / xlsx / odt / odp / ods) are ZIP
*    archives of XML, so the XML parts are inflated with `node:zlib` and their
*    text nodes are pulled out in document order;
*  - PDFs are scanned for FlateDecode content streams and the text-showing
*    operators are decoded.
*
* Anything else (images, media, archives, opaque binaries) reports
* `supported: false` with a reason instead of silently returning noise, so the
* UI can suggest the heavy agent tier instead.
*/
/** Cap on extracted text handed to a model (about 200k characters). */
const MAX_EXTRACTED_CHARS = 2e5;
const TEXT_EXTENSIONS = /* @__PURE__ */ new Set([
	"txt",
	"text",
	"log",
	"md",
	"markdown",
	"mdx",
	"csv",
	"tsv",
	"json",
	"jsonl",
	"ndjson",
	"yaml",
	"yml",
	"toml",
	"ini",
	"cfg",
	"conf",
	"env",
	"properties",
	"xml",
	"html",
	"htm",
	"css",
	"scss",
	"less",
	"js",
	"mjs",
	"cjs",
	"ts",
	"tsx",
	"jsx",
	"py",
	"rb",
	"go",
	"rs",
	"java",
	"kt",
	"c",
	"h",
	"cc",
	"cpp",
	"hpp",
	"cs",
	"php",
	"swift",
	"sql",
	"sh",
	"bat",
	"ps1",
	"lua",
	"r",
	"pl",
	"vue",
	"svelte"
]);
const OOXML_PART_PATTERN = /^(word\/document\.xml|ppt\/slides\/slide\d+\.xml|ppt\/notesSlides\/notesSlide\d+\.xml|xl\/sharedStrings\.xml|xl\/worksheets\/sheet\d+\.xml|content\.xml)$/i;
const ODF_PART_PATTERN = /^content\.xml$/i;
/** Decode bytes as UTF-8, falling back to a Latin-1 read for odd encodings. */
function decodeText$1(data) {
	const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(data);
	if ((utf8.match(/\uFFFD/g)?.length ?? 0) / Math.max(1, utf8.length) < .02) return utf8;
	return new TextDecoder("latin1").decode(data);
}
function extensionOf$1(name) {
	const match = /\.([a-z0-9]+)$/i.exec(name.trim());
	return match === null ? "" : match[1].toLowerCase();
}
/** Strip XML markup and decode the entities OOXML/ODF bodies actually use. */
function xmlToText(xml) {
	return xml.replace(/<\/w:p>|<\/a:p>|<\/text:p>|<\/text:h>|<\/w:tr>/gi, "\n").replace(/<w:tab\b[^>]*\/>|<a:br\b[^>]*\/>/gi, "	").replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&amp;/g, "&").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
/** Pull readable text out of a PDF's FlateDecode content streams. */
function extractPdfText(data) {
	const chunks = [];
	const marker = Buffer.from("stream");
	let cursor = 0;
	while (cursor < data.length && chunks.length < 400) {
		const at = data.indexOf(marker, cursor);
		if (at < 0) break;
		let start = at + marker.length;
		if (data[start] === 13) start += 1;
		if (data[start] === 10) start += 1;
		const end = data.indexOf(Buffer.from("endstream"), start);
		if (end < 0) break;
		cursor = end + 9;
		const raw = data.subarray(start, end);
		let inflated;
		try {
			inflated = inflateSync(raw);
		} catch {
			inflated = void 0;
		}
		if (inflated === void 0) continue;
		const content = inflated.toString("latin1");
		if (!/BT[\s\S]{0,4000}?ET/.test(content)) continue;
		const texts = [];
		const pattern = /\((?:\\.|[^\\()])*\)/g;
		let match;
		while ((match = pattern.exec(content)) !== null) {
			const decoded = match[0].slice(1, -1).replace(/\\([nrtbf])/g, (_, code) => code === "n" ? "\n" : code === "r" ? "\n" : code === "t" ? "	" : "").replace(/\\([()\\])/g, "$1").replace(/\\(\d{1,3})/g, (_, oct) => String.fromCharCode(parseInt(oct, 8)));
			if (decoded.trim() !== "") texts.push(decoded);
		}
		if (texts.length > 0) chunks.push(texts.join(" "));
	}
	return chunks.join("\n").replace(/[ \t]{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}
function truncate(text) {
	if (text.length <= 2e5) return {
		text,
		truncated: false
	};
	return {
		text: text.slice(0, MAX_EXTRACTED_CHARS),
		truncated: true
	};
}
/**
* Extract readable text from one stored file asset.
* @param data - raw file bytes.
* @param name - original file name (drives the format decision).
* @param mime - stored MIME type, used when the name has no extension.
* @returns extraction result; never throws for malformed input.
*/
function extractFileText(data, name, mime = "") {
	const extension = extensionOf$1(name);
	const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
	const looksZip = buffer.length > 4 && buffer[0] === 80 && buffer[1] === 75;
	if (buffer.length > 5 && buffer.subarray(0, 5).toString("latin1") === "%PDF-" || extension === "pdf") {
		const text = extractPdfText(buffer);
		const cut = truncate(text);
		if (text.trim() === "") return {
			supported: false,
			format: "pdf",
			text: "",
			truncated: false,
			warning: "PDF 未能提取到可读文字（可能是扫描件或使用了非标准编码），建议改用「重任务」技能或先转成图片节点走视觉模型。"
		};
		return {
			supported: true,
			format: "pdf",
			text: cut.text,
			truncated: cut.truncated,
			warning: "PDF 文字为启发式提取，复杂排版可能丢失顺序。"
		};
	}
	if (looksZip) {
		const entries = readZipDirectory(buffer);
		const isOdf = entries.some((entry) => ODF_PART_PATTERN.test(entry.name));
		const wanted = entries.filter((entry) => isOdf ? ODF_PART_PATTERN.test(entry.name) : OOXML_PART_PATTERN.test(entry.name));
		if (wanted.length > 0) {
			const parts = [];
			for (const entry of wanted.sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }))) {
				const raw = readZipEntry(buffer, entry);
				if (raw === void 0) continue;
				const text = xmlToText(decodeText$1(raw));
				if (text !== "") parts.push(text);
			}
			const joined = parts.join("\n\n");
			const cut = truncate(joined);
			const format = extension === "" ? isOdf ? "odf" : "ooxml" : extension;
			if (joined.trim() === "") return {
				supported: false,
				format,
				text: "",
				truncated: false,
				warning: "文档里没有提取到文字（可能是纯图片幻灯片或表格）。可以先转成图片节点，再交给视觉模型处理。"
			};
			return {
				supported: true,
				format,
				text: cut.text,
				truncated: cut.truncated
			};
		}
		return {
			supported: false,
			format: extension === "" ? "zip" : extension,
			text: "",
			truncated: false,
			warning: "压缩包不能直接抽取内容，请先解压后上传其中的文档。"
		};
	}
	if (TEXT_EXTENSIONS.has(extension) || mime.startsWith("text/") || mime === "application/json" || mime === "application/xml" || mime === "application/x-yaml" || mime === "application/yaml") {
		const cut = truncate(decodeText$1(buffer));
		return {
			supported: true,
			format: extension === "" ? "text" : extension,
			text: cut.text,
			truncated: cut.truncated
		};
	}
	return {
		supported: false,
		format: extension === "" ? "binary" : extension,
		text: "",
		truncated: false,
		warning: `无法把 .${extension === "" ? "bin" : extension} 文件当作文本读取，请换用支持该格式的技能，或先转成文本/图片节点。`
	};
}
//#endregion
//#region src/file-preview.ts
/**
* Content previews for canvas file nodes.
*
* A file node stores arbitrary bytes, so the browser cannot be handed a URL and
* told to render them: HTML/SVG-shaped payloads must never execute in the app's
* origin, and office documents are ZIP containers rather than viewable pages.
* This module turns one stored asset into a bounded, structured preview:
*
*  - images / PDFs / audio / video return an inline URL (the only types the
*    asset route will serve inline — see the route's MIME allow-list);
*  - HTML / SVG / Markdown decode whole so the client can render them as the
*    original document (sandboxed iframe / `<img>` / rich-text renderer);
*  - CSV / TSV / XLSX become a grid;
*  - DOCX parses into headings, lists, tables and styled runs; PPTX into one
*    card per slide with its text and embedded pictures;
*  - remaining text-like / office files reuse the extractor the
*    `extract.content` skill already relies on;
*  - ZIP archives list their central directory.
*
* Every branch is bounded: a hostile or merely huge file can waste CPU here,
* but it cannot make the host allocate unbounded memory or hang the request.
*/
/** Characters of text handed to the viewer (about 120k, ~350KB of JSON). */
const MAX_PREVIEW_CHARS = 12e4;
const MAX_PREVIEW_MEDIA_BYTES = 6 * 1024 * 1024;
/** Image MIME types every current browser renders inside an `<img>`. */
const INLINE_IMAGE_MIME = /^image\/(png|jpeg|webp|gif|bmp)$/;
/** Delimited text formats turned into a grid instead of a wall of commas. */
const TABLE_EXTENSIONS = /* @__PURE__ */ new Set(["csv", "tsv"]);
/** Raster formats an `<img>` tag can show; EMF/WMF metafiles are skipped. */
const IMAGE_MIME_BY_EXTENSION = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	bmp: "image/bmp",
	webp: "image/webp"
};
function extensionOf(name) {
	if (name === void 0) return "";
	return path.extname(name).replace(/^\./, "").toLowerCase();
}
function decodeText(data) {
	const utf8 = new TextDecoder("utf-8", { fatal: false }).decode(data);
	if ((utf8.match(/\uFFFD/g)?.length ?? 0) / Math.max(1, utf8.length) < .02) return utf8;
	return new TextDecoder("latin1").decode(data);
}
function decodeXmlEntities(value) {
	return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))).replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&amp;/g, "&");
}
function clampText(text) {
	const cap = Math.min(MAX_PREVIEW_CHARS, MAX_EXTRACTED_CHARS);
	if (text.length <= cap) return {
		text,
		truncated: false
	};
	return {
		text: text.slice(0, cap),
		truncated: true
	};
}
/** Split one delimited document into rows, honouring quotes and embedded newlines. */
function parseDelimited(text, delimiter) {
	const rows = [];
	let row = [];
	let field = "";
	let quoted = false;
	let totalRows = 0;
	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		if (quoted) {
			if (char === "\"") if (text[index + 1] === "\"") {
				field += "\"";
				index += 1;
			} else quoted = false;
			else field += char;
			continue;
		}
		if (char === "\"" && field === "") {
			quoted = true;
			continue;
		}
		if (char === delimiter) {
			row.push(field);
			field = "";
			continue;
		}
		if (char === "\n" || char === "\r") {
			if (char === "\r" && text[index + 1] === "\n") index += 1;
			row.push(field);
			field = "";
			totalRows += 1;
			if (rows.length < 300) rows.push(row.slice(0, 40));
			row = [];
			continue;
		}
		field += char;
	}
	if (field !== "" || row.length > 0) {
		row.push(field);
		totalRows += 1;
		if (rows.length < 300) rows.push(row.slice(0, 40));
	}
	return {
		rows,
		totalRows
	};
}
/** Column index of an A1-style cell reference (`B7` -> 1). */
function columnIndex(reference) {
	const letters = /^([A-Z]+)/i.exec(reference)?.[1];
	if (letters === void 0) return 0;
	let value = 0;
	for (const char of letters.toUpperCase()) value = value * 26 + (char.charCodeAt(0) - 64);
	return Math.max(0, value - 1);
}
/** Shared-string table of one XLSX workbook (`xl/sharedStrings.xml`). */
function readSharedStrings(buffer, entries) {
	const entry = entries.find((item) => item.name.toLowerCase() === "xl/sharedstrings.xml");
	if (entry === void 0) return [];
	const raw = readZipEntry(buffer, entry);
	if (raw === void 0) return [];
	const xml = decodeText(raw);
	const out = [];
	const itemPattern = /<si\b[^>]*>([\s\S]*?)<\/si>|<si\s*\/>/g;
	let match;
	while ((match = itemPattern.exec(xml)) !== null) {
		const body = match[1] ?? "";
		let text = "";
		const textPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
		let part;
		while ((part = textPattern.exec(body)) !== null) text += decodeXmlEntities(part[1] ?? "");
		out.push(text);
	}
	return out;
}
/** Read the first worksheet of an XLSX workbook into a bounded grid. */
function readXlsxGrid(buffer) {
	const entries = readZipDirectory(buffer);
	if (entries.length === 0) return void 0;
	const sheets = entries.filter((entry) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
	if (sheets.length === 0) return void 0;
	const raw = readZipEntry(buffer, sheets[0]);
	if (raw === void 0) return void 0;
	const shared = readSharedStrings(buffer, entries);
	const xml = decodeText(raw);
	const rows = [];
	let totalRows = 0;
	let more = false;
	const rowPattern = /<row\b[^>]*>([\s\S]*?)<\/row>|<row\b[^>]*\/>/g;
	let rowMatch;
	while ((rowMatch = rowPattern.exec(xml)) !== null) {
		if (rows.length >= 300) {
			more = true;
			break;
		}
		totalRows += 1;
		const body = rowMatch[1] ?? "";
		const cells = [];
		const cellPattern = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
		let cellMatch;
		while ((cellMatch = cellPattern.exec(body)) !== null) {
			const attributes = cellMatch[1] ?? "";
			const inner = cellMatch[2] ?? "";
			const reference = /r="([A-Z]+\d+)"/i.exec(attributes)?.[1] ?? "";
			const type = /t="([a-z]+)"/i.exec(attributes)?.[1]?.toLowerCase() ?? "";
			let value = "";
			if (type === "s") value = shared[Number(/<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "")] ?? "";
			else if (type === "inlinestr") {
				const textPattern = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
				let part;
				while ((part = textPattern.exec(inner)) !== null) value += decodeXmlEntities(part[1] ?? "");
			} else {
				const raw = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? "";
				value = type === "b" ? raw.trim() === "1" ? "TRUE" : "FALSE" : decodeXmlEntities(raw);
			}
			const column = reference === "" ? cells.length : columnIndex(reference);
			if (column >= 40) continue;
			while (cells.length < column) cells.push("");
			cells[column] = value;
		}
		rows.push(cells.map((cell) => cell ?? ""));
	}
	if (totalRows === 0) return void 0;
	return {
		rows,
		totalRows,
		truncated: more
	};
}
/** Whether an on/off run property (`<w:b>` / `<w:i>`) is switched on. */
function docxRunFlag(body, tag) {
	const pattern = new RegExp(`<w:${tag}(?=[\\s/>])[^>]*>`, "g");
	let on = false;
	let match;
	while ((match = pattern.exec(body)) !== null) on = !/w:val="(?:0|false|off)"/i.test(match[0]);
	return on || void 0;
}
/** Styled runs of one DOCX paragraph fragment; adjacent same-style runs merge. */
function docxRuns(fragment) {
	const runs = [];
	const runPattern = /<w:r\b[^>]*(?:\/>|>([\s\S]*?)<\/w:r>)/g;
	let match;
	while ((match = runPattern.exec(fragment)) !== null) {
		const body = match[1] ?? "";
		let text = "";
		const partPattern = /<w:t\b[^>]*\/>|<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:br\b[^>]*\/>|<w:tab\b[^>]*\/>/g;
		let part;
		while ((part = partPattern.exec(body)) !== null) if (part[0].startsWith("<w:br")) text += "\n";
		else if (part[0].startsWith("<w:tab")) text += "	";
		else text += decodeXmlEntities(part[1] ?? "");
		if (text === "") continue;
		const bold = docxRunFlag(body, "b");
		const italic = docxRunFlag(body, "i");
		const previous = runs.at(-1);
		if (previous !== void 0 && !!previous.bold === !!bold && !!previous.italic === !!italic) {
			previous.text += text;
			continue;
		}
		runs.push({
			text,
			...bold === void 0 ? {} : { bold },
			...italic === void 0 ? {} : { italic }
		});
	}
	return runs;
}
/** numId -> list kind (`bullet` vs everything counted) from `word/numbering.xml`. */
function readDocxNumbering(buffer, entries) {
	const orderedByNumId = /* @__PURE__ */ new Map();
	const entry = entries.find((item) => item.name.toLowerCase() === "word/numbering.xml");
	if (entry === void 0) return orderedByNumId;
	const raw = readZipEntry(buffer, entry);
	if (raw === void 0) return orderedByNumId;
	const xml = decodeText(raw);
	const orderedByAbstract = /* @__PURE__ */ new Map();
	const abstractPattern = /<w:abstractNum\b[^>]*w:abstractNumId="(\d+)"[^>]*>([\s\S]*?)<\/w:abstractNum>/g;
	let abstract;
	while ((abstract = abstractPattern.exec(xml)) !== null) {
		const format = /<w:numFmt w:val="([^"]+)"/.exec(abstract[2] ?? "")?.[1]?.toLowerCase();
		orderedByAbstract.set(abstract[1], format !== "bullet");
	}
	const numPattern = /<w:num\b[^>]*w:numId="(\d+)"[^>]*>[\s\S]*?<w:abstractNumId w:val="(\d+)"[^>]*\/>[\s\S]*?<\/w:num>/g;
	let num;
	while ((num = numPattern.exec(xml)) !== null) {
		const ordered = orderedByAbstract.get(num[2]);
		if (ordered !== void 0) orderedByNumId.set(num[1], ordered);
	}
	return orderedByNumId;
}
/** Cell texts of one DOCX table (`<w:tbl>` fragment), one paragraph per line. */
function docxTableRows(fragment) {
	const rows = [];
	const rowPattern = /<w:tr\b[\s\S]*?<\/w:tr>/g;
	let row;
	while ((row = rowPattern.exec(fragment)) !== null && rows.length < 300) {
		const cells = [];
		const cellPattern = /<w:tc\b[\s\S]*?<\/w:tc>/g;
		let cell;
		while ((cell = cellPattern.exec(row[0])) !== null && cells.length < 40) {
			const paragraphs = [];
			const paraPattern = /<w:p\b[^>]*(?:\/>|>[\s\S]*?<\/w:p>)/g;
			let para;
			while ((para = paraPattern.exec(cell[0])) !== null) {
				const text = docxRuns(para[0]).map((run) => run.text).join("").replace(/\s+/g, " ").trim();
				if (text !== "") paragraphs.push(text);
			}
			cells.push(paragraphs.join("\n"));
		}
		rows.push(cells);
	}
	return rows;
}
/** Structured preview of a DOCX body: headings, lists, tables, styled runs.
*  Undefined when the document has no body blocks (flat extraction takes over). */
function readDocxBlocks(buffer) {
	const entries = readZipDirectory(buffer);
	const documentEntry = entries.find((item) => item.name.toLowerCase() === "word/document.xml");
	if (documentEntry === void 0) return void 0;
	const raw = readZipEntry(buffer, documentEntry);
	if (raw === void 0) return void 0;
	const xml = decodeText(raw);
	const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? xml;
	const numbering = readDocxNumbering(buffer, entries);
	const blocks = [];
	let truncated = false;
	let chars = 0;
	let list;
	const flushList = () => {
		if (list !== void 0 && list.items.length > 0) blocks.push({
			type: "list",
			ordered: list.ordered,
			items: list.items
		});
		list = void 0;
	};
	const scanner = /<w:tbl[ >]|<w:p[ >/]/g;
	scanner.lastIndex = 0;
	let match;
	while ((match = scanner.exec(body)) !== null) {
		if (blocks.length >= 900) {
			truncated = true;
			break;
		}
		if (match[0].startsWith("<w:p")) {
			const tagEnd = body.indexOf(">", match.index);
			if (tagEnd < 0) {
				truncated = true;
				break;
			}
			if (body[tagEnd - 1] === "/") {
				scanner.lastIndex = tagEnd + 1;
				continue;
			}
		}
		if (match[0].startsWith("<w:tbl")) {
			let depth = 0;
			let end = -1;
			const tagPattern = /<\/?w:tbl[ >]/g;
			tagPattern.lastIndex = match.index;
			let tag;
			while ((tag = tagPattern.exec(body)) !== null) {
				depth += tag[0].startsWith("</") ? -1 : 1;
				if (depth === 0) {
					end = tag.index + tag[0].length;
					break;
				}
			}
			if (end < 0) {
				truncated = true;
				break;
			}
			flushList();
			const rows = docxTableRows(body.slice(match.index, end));
			if (rows.length > 0) blocks.push({
				type: "table",
				rows
			});
			scanner.lastIndex = end;
			continue;
		}
		const close = body.indexOf("</w:p>", match.index);
		if (close < 0) {
			truncated = true;
			break;
		}
		const fragment = body.slice(match.index, close + 6);
		scanner.lastIndex = close + 6;
		const style = /<w:pStyle w:val="([^"]+)"/i.exec(fragment)?.[1] ?? "";
		let headingLevel = 0;
		const headingStyle = /^heading([1-9])$/i.exec(style);
		if (headingStyle !== null) headingLevel = Math.min(3, Number(headingStyle[1]));
		else if (/^title$/i.test(style)) headingLevel = 1;
		else if (/^subtitle$/i.test(style)) headingLevel = 2;
		else {
			const outline = /<w:outlineLvl w:val="([0-8])"/i.exec(fragment)?.[1];
			if (outline !== void 0) headingLevel = Math.min(3, Number(outline) + 1);
		}
		const runs = docxRuns(fragment);
		const text = runs.map((run) => run.text).join("");
		if (text.trim() === "") {
			flushList();
			continue;
		}
		chars += text.length;
		if (chars > 12e4) {
			truncated = true;
			break;
		}
		const numId = /<w:numId w:val="(\d+)"\s*\/>/i.exec(fragment)?.[1];
		if (headingLevel > 0 || numId === void 0 || numId === "0") {
			flushList();
			if (headingLevel > 0) blocks.push({
				type: "heading",
				level: headingLevel,
				runs
			});
			else blocks.push({
				type: "paragraph",
				runs
			});
			continue;
		}
		const ordered = numbering.get(numId) ?? false;
		if (list !== void 0 && list.ordered !== ordered) flushList();
		if (list === void 0) list = {
			ordered,
			items: []
		};
		list.items.push(runs);
	}
	flushList();
	if (blocks.length === 0) return void 0;
	return {
		blocks,
		truncated
	};
}
/** Paragraph texts of one PPTX shape / table fragment (one entry per `<a:p>`). */
function slideParagraphs(fragment) {
	const out = [];
	const paragraphPattern = /<a:p\b[\s\S]*?<\/a:p>/g;
	let paragraph;
	while ((paragraph = paragraphPattern.exec(fragment)) !== null) {
		let text = paragraph[0].replace(/<a:fld\b[\s\S]*?<\/a:fld>/g, "");
		let value = "";
		const textPattern = /<a:t\b[^>]*\/>|<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g;
		let part;
		while ((part = textPattern.exec(text)) !== null) value += decodeXmlEntities(part[1] ?? "");
		value = value.replace(/\s+/g, " ").trim();
		if (value !== "") out.push(value);
	}
	return out;
}
/** Slide-deck preview: one entry per slide with title, body lines and pictures.
*  Pictures ride along as data URLs within a shared byte budget so an
*  image-heavy deck still comes back bounded. */
function readPptxSlides(buffer) {
	const entries = readZipDirectory(buffer);
	const slideEntries = entries.filter((entry) => /^ppt\/slides\/slide\d+\.xml$/i.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
	if (slideEntries.length === 0) return void 0;
	/** rId -> zip path of one slide's relationship target. */
	const relsOf = (slideName) => {
		const map = /* @__PURE__ */ new Map();
		const relEntry = entries.find((item) => item.name.toLowerCase() === `ppt/slides/_rels/${slideName.toLowerCase()}.rels`);
		if (relEntry === void 0) return map;
		const raw = readZipEntry(buffer, relEntry);
		if (raw === void 0) return map;
		const relPattern = /<Relationship\b[^>]*>/g;
		let rel;
		while ((rel = relPattern.exec(decodeText(raw))) !== null) {
			const id = /\bId="([^"]+)"/.exec(rel[0])?.[1];
			const target = /\bTarget="([^"]+)"/.exec(rel[0])?.[1];
			if (id === void 0 || target === void 0) continue;
			const stack = [];
			for (const part of `ppt/slides/${target}`.split("/")) {
				if (part === "" || part === ".") continue;
				if (part === "..") stack.pop();
				else stack.push(part);
			}
			map.set(id, stack.join("/"));
		}
		return map;
	};
	const slides = [];
	let mediaBudget = MAX_PREVIEW_MEDIA_BYTES;
	let truncated = false;
	for (const slideEntry of slideEntries) {
		if (slides.length >= 80) {
			truncated = true;
			break;
		}
		const raw = readZipEntry(buffer, slideEntry);
		if (raw === void 0) continue;
		const xml = decodeText(raw);
		const slide = {
			lines: [],
			images: []
		};
		const rels = relsOf(slideEntry.name.replace(/^ppt\/slides\//i, ""));
		const blipPattern = /<a:blip\b[^>]*r:embed="([^"]+)"/g;
		let blip;
		while ((blip = blipPattern.exec(xml)) !== null && slide.images.length < 6) {
			const target = rels.get(blip[1]);
			if (target === void 0) continue;
			const mime = IMAGE_MIME_BY_EXTENSION[target.split(".").pop()?.toLowerCase() ?? ""];
			if (mime === void 0) continue;
			const mediaEntry = entries.find((item) => item.name.toLowerCase() === target.toLowerCase());
			if (mediaEntry === void 0 || mediaEntry.uncompressedSize > mediaBudget) {
				truncated = true;
				continue;
			}
			const media = readZipEntry(buffer, mediaEntry);
			if (media === void 0) continue;
			mediaBudget -= media.byteLength;
			slide.images.push({
				mime,
				data: `data:${mime};base64,${media.toString("base64")}`
			});
		}
		const shapePattern = /<p:sp\b[\s\S]*?<\/p:sp>/g;
		let shape;
		while ((shape = shapePattern.exec(xml)) !== null) {
			const paragraphs = slideParagraphs(shape[0]);
			if (paragraphs.length === 0) continue;
			if (/<p:ph\b[^>]*type="(?:ctrTitle|title)"/.test(shape[0]) && slide.title === void 0) slide.title = paragraphs.join(" ");
			else slide.lines.push(...paragraphs);
		}
		const tablePattern = /<a:tbl\b[\s\S]*?<\/a:tbl>/g;
		let table;
		while ((table = tablePattern.exec(xml)) !== null) slide.lines.push(...slideParagraphs(table[0]));
		slides.push(slide);
	}
	return {
		slides,
		truncated
	};
}
/** Content preview of one stored canvas file asset. Never throws. */
function buildFilePreview(input) {
	const name = input.name ?? "";
	const extension = extensionOf(name);
	const mime = baseMime$1(input.mime);
	const data = Buffer.from(input.data.buffer, input.data.byteOffset, input.data.byteLength);
	const kind = fileKindOf(mime, name);
	if (INLINE_IMAGE_MIME.test(mime) || kind === "image" && [
		"png",
		"jpg",
		"jpeg",
		"webp",
		"gif",
		"bmp"
	].includes(extension)) return {
		kind: "media",
		media: "image",
		url: input.url,
		width: 0,
		height: 0
	};
	if (mime === "application/pdf" || extension === "pdf") return {
		kind: "media",
		media: "pdf",
		url: input.url,
		width: 0,
		height: 0
	};
	if (mime.startsWith("audio/")) return {
		kind: "media",
		media: "audio",
		url: input.url,
		width: 0,
		height: 0
	};
	if (mime.startsWith("video/")) return {
		kind: "media",
		media: "video",
		url: input.url,
		width: 0,
		height: 0
	};
	const decoded = () => {
		const text = decodeText(data);
		return text.includes("\0") ? void 0 : text;
	};
	if ([
		"md",
		"markdown",
		"mdx"
	].includes(extension) || mime === "text/markdown" || mime === "text/x-markdown") {
		const text = decoded();
		if (text !== void 0) {
			const cut = clampText(text);
			return {
				kind: "markdown",
				format: "markdown",
				markdown: cut.text,
				truncated: cut.truncated
			};
		}
	}
	if (extension === "html" || extension === "htm" || mime === "text/html") {
		const text = decoded();
		if (text !== void 0) {
			const cut = clampText(text);
			return {
				kind: "html",
				format: "html",
				html: cut.text,
				truncated: cut.truncated
			};
		}
	}
	if (extension === "svg" || mime === "image/svg+xml") {
		const text = decoded();
		if (text !== void 0) {
			const cut = clampText(text);
			return {
				kind: "svg",
				format: "svg",
				svg: cut.text,
				truncated: cut.truncated
			};
		}
	}
	const looksZip = data.length > 4 && data[0] === 80 && data[1] === 75;
	if (extension === "xlsx" || mime.includes("spreadsheetml.sheet")) {
		if (looksZip) {
			const grid = readXlsxGrid(data);
			if (grid !== void 0) return {
				kind: "table",
				format: "xlsx",
				rows: grid.rows,
				totalRows: grid.totalRows,
				truncated: grid.truncated
			};
		}
	}
	if (TABLE_EXTENSIONS.has(extension) || mime === "text/csv" || mime === "text/tab-separated-values") {
		const decoded = decodeText(data);
		if (!decoded.includes("\0")) {
			const parsed = parseDelimited(decoded, extension === "tsv" || mime === "text/tab-separated-values" ? "	" : ",");
			return {
				kind: "table",
				format: extension === "" ? "csv" : extension,
				rows: parsed.rows,
				totalRows: parsed.totalRows,
				truncated: parsed.totalRows > parsed.rows.length
			};
		}
	}
	if (isTextMime(mime) || kind === "text" || kind === "office") {
		if (looksZip && (extension === "docx" || mime.includes("wordprocessingml.document"))) {
			const document = readDocxBlocks(data);
			if (document !== void 0) return {
				kind: "document",
				format: "docx",
				blocks: document.blocks,
				truncated: document.truncated
			};
		}
		if (looksZip && (extension === "pptx" || mime.includes("presentationml.presentation"))) {
			const deck = readPptxSlides(data);
			if (deck !== void 0) return {
				kind: "slides",
				format: "pptx",
				slides: deck.slides,
				truncated: deck.truncated
			};
		}
		const extracted = extractFileText(data, name, mime);
		if (extracted.supported) {
			const cut = clampText(extracted.text);
			return {
				kind: "text",
				format: extracted.format,
				text: cut.text,
				truncated: cut.truncated || extracted.truncated,
				lines: cut.text === "" ? 0 : cut.text.split("\n").length,
				...extracted.warning === void 0 ? {} : { warning: extracted.warning }
			};
		}
		return {
			kind: "none",
			format: extracted.format,
			reason: "unreadable",
			message: extracted.warning ?? "无法读取此文件的文字内容。"
		};
	}
	if (looksZip || kind === "archive") {
		const entries = looksZip ? readZipDirectory(data) : [];
		if (entries.length > 0) return {
			kind: "archive",
			entries: entries.slice(0, 400).map((entry) => ({
				name: entry.name,
				size: entry.uncompressedSize,
				dir: isZipDirectory(entry)
			})),
			totalEntries: entries.length,
			truncated: entries.length > 400
		};
		return {
			kind: "none",
			format: extension === "" ? "archive" : extension,
			reason: "unsupported",
			message: "这个压缩格式无法在画布内展开，请下载后用系统程序查看。"
		};
	}
	return {
		kind: "none",
		format: extension === "" ? mime === "" ? "bin" : mime : extension,
		reason: "unsupported",
		message: "这种格式没有可读内容，请下载后查看，或先转成图片 / 文本节点再交给技能处理。"
	};
}
//#endregion
//#region src/templates-store.ts
/**
* Prompt-template library store (multi-source).
*
* The library is a registry of independent sources (see TEMPLATE_SOURCES in
* protocol.ts): each source has its own upstream JSON list, its own bundled
* snapshot, its own refreshed runtime copy, and its own on-disk image pool.
* Sources never mix — the overlay shows one tab per source and every request
* names the source explicitly.
*
* Each case list ships as a bundled snapshot (src/templates/<file>, inside the
* npm package) so every library works offline out of the box; a successful
* refresh (manual, or the periodic background sync) writes a runtime copy
* under ~/.dsh/dsh-imagegen/templates/<sourceId>/ which then takes precedence.
* Reference images are not bundled (hundreds of files, ≈100 MB per source) —
* they are fetched from the source's mirror on demand, cached on disk under
* ~/.dsh/dsh-imagegen/template-images/<sourceId>/, and served from there on
* every later view.
*
* Framework-free (node:fs only) so the route layer and tests can drive it
* directly.
*/
/** Source registry (host half): where each TEMPLATE_SOURCES entry loads from. */
const SOURCE_DEFS = {
	vibeui: {
		listUrl: "https://vibeui.top/extra/awesome-gpt-image-2/data/cases.json",
		imageBaseUrl: "https://vibeui.top/extra/awesome-gpt-image-2/data/images/",
		bundledPath: fileURLToPath(new URL("../src/templates/cases.json", import.meta.url)),
		legacySnapshotPath: "legacy",
		legacyImageDir: "legacy"
	},
	canghe: {
		listUrl: "https://gpt-image2.canghe.ai/cases.json",
		imageBaseUrl: "https://gpt-image2.canghe.ai/images/",
		bundledPath: fileURLToPath(new URL("../src/templates/canghe-cases.json", import.meta.url))
	},
	handraw: {
		bundledPath: fileURLToPath(new URL("../src/templates/handraw-cases.json", import.meta.url)),
		refreshable: false,
		allowedImageHosts: ["cdn.jsdelivr.net", "raw.githubusercontent.com"],
		imageUrls: (ref) => {
			const match = /^https:\/\/cdn\.jsdelivr\.net\/gh\/yang0\/handraw-style@([^/]+)(\/.*)$/i.exec(ref);
			return match?.[1] !== void 0 && match[2] !== void 0 ? [ref, `https://raw.githubusercontent.com/yang0/handraw-style/${match[1]}${match[2]}`] : [ref];
		}
	},
	"prompt-signal": {
		bundledPath: fileURLToPath(new URL("../src/templates/prompt-signal-cases.json", import.meta.url)),
		refreshable: false,
		allowedImageHosts: [
			"raw.githubusercontent.com",
			"pbs.twimg.com",
			"mosaic.fxtwitter.com"
		]
	},
	evolink: {
		bundledPath: fileURLToPath(new URL("../src/templates/evolink-cases.json", import.meta.url)),
		refreshable: false,
		allowedImageHosts: ["raw.githubusercontent.com"]
	}
};
/** Category label map mirrored from the upstream sites' site.js (zh names). */
const CATEGORY_ZH = {
	"Architecture & Spaces": "建筑与空间",
	"Brand & Logos": "品牌与标志",
	"Characters & People": "人物与角色",
	"Charts & Infographics": "图表与信息可视化",
	"Documents & Publishing": "文档与出版物",
	"History & Classical Themes": "历史与古风题材",
	"Illustration & Art": "插画与艺术",
	"Other Use Cases": "其他应用场景",
	"Photography & Realism": "摄影与写实",
	"Posters & Typography": "海报与排版",
	"Products & E-commerce": "商品与电商",
	"Scenes & Storytelling": "场景与叙事",
	"UI & Interfaces": "UI 与界面",
	"Portraits & Fashion": "人像与时尚",
	"Celebrities & Sports": "名人与运动",
	"Characters & IP": "角色与 IP",
	"Food & Beverage": "美食与饮品",
	"Brand & Icons": "品牌与图标",
	"Social Media & Stickers": "社媒与表情包",
	"Infographics & Diagrams": "信息图与图解",
	"UI & App Screens": "UI 与应用界面",
	"Architecture & Interiors": "建筑与室内",
	"Cinematic & Storytelling": "影视与叙事",
	"Illustration & Comics": "插画与漫画",
	"Historical & Fantasy": "历史与幻想",
	"Animals & Nature": "动物与自然",
	"Other Creative Uses": "其他创意用途"
};
const DATA_DIR$1 = path.join(homedir(), ".dsh", "dsh-imagegen");
const REFRESHED_DIR = path.join(DATA_DIR$1, "templates");
const IMAGE_CACHE_ROOT = path.join(DATA_DIR$1, "template-images");
/** Pre-1.6 single-source locations (vibeui fallbacks). */
const LEGACY_SNAPSHOT_PATH = path.join(REFRESHED_DIR, "cases.json");
const LEGACY_IMAGE_DIR = IMAGE_CACHE_ROOT;
/** Budget for one upstream fetch (list refresh or one image). */
const FETCH_TIMEOUT_MS = 6e4;
/** Refuse to cache implausibly large "images". */
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
/** Strict legacy reference-image file names this store writes and serves. */
const IMAGE_FILE_PATTERN = /^case\d+\.(jpg|jpeg|png|webp|gif)$/i;
/** Absolute image URL length accepted from bundled/refreshed snapshots. */
const MAX_IMAGE_URL_LENGTH = 4e3;
/** Per-source in-memory memo of the active list (avoid re-parsing per request). */
const memos = /* @__PURE__ */ new Map();
/** Per-file in-flight downloads, so a gallery scroll never double-fetches. */
const inflightImages = /* @__PURE__ */ new Map();
/** Resolve a registered source id to its fetch definition. */
function sourceDefOf(sourceId) {
	return SOURCE_DEFS[sourceId];
}
/** Validate + normalize one raw upstream case; undefined when unusable. */
function normalizeCase(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const record = raw;
	const id = typeof record.id === "number" && Number.isFinite(record.id) ? String(record.id) : typeof record.id === "string" ? record.id.trim() : "";
	const title = typeof record.title === "string" ? record.title.trim() : "";
	const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
	if (id === "" || title === "" || prompt === "") return void 0;
	const category = typeof record.category === "string" ? record.category : "";
	const image = imageRefOf(typeof record.image === "string" ? record.image : "");
	return {
		id,
		title,
		prompt,
		category,
		categoryZh: typeof record.categoryZh === "string" && record.categoryZh.trim() !== "" ? record.categoryZh.trim() : CATEGORY_ZH[category] ?? category,
		styles: Array.isArray(record.styles) ? record.styles.map(String) : [],
		scenes: Array.isArray(record.scenes) ? record.scenes.map(String) : [],
		sourceLabel: typeof record.sourceLabel === "string" ? record.sourceLabel : "",
		sourceUrl: typeof record.sourceUrl === "string" ? record.sourceUrl : "",
		githubUrl: typeof record.githubUrl === "string" ? record.githubUrl : "",
		image,
		featured: record.featured === true
	};
}
/** Accept either a legacy bare file name or a safe absolute image URL. */
function imageRefOf(value) {
	const raw = value.trim();
	if (/^https?:\/\//i.test(raw)) {
		if (raw.length > MAX_IMAGE_URL_LENGTH) return "";
		try {
			const url = new URL(raw);
			return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" ? url.toString() : "";
		} catch {
			return "";
		}
	}
	const name = raw.replace(/^\/+/, "").split("/").pop() ?? "";
	return IMAGE_FILE_PATTERN.test(name) ? name : "";
}
/** Parse a snapshot payload (bundled, refreshed cache, or fresh download). */
function parseSnapshot(payload) {
	if (payload === null || typeof payload !== "object") return void 0;
	const snapshot = payload;
	if (!Array.isArray(snapshot.cases)) return void 0;
	const cases = [];
	for (const raw of snapshot.cases) {
		const normalized = normalizeCase(raw);
		if (normalized !== void 0) cases.push(normalized);
	}
	if (cases.length === 0) return void 0;
	return {
		cases,
		repository: typeof snapshot.repository === "string" && snapshot.repository !== "" ? snapshot.repository : "freestylefly/awesome-gpt-image-2",
		fetchedAt: typeof snapshot.fetchedAt === "string" && snapshot.fetchedAt !== "" ? snapshot.fetchedAt : ""
	};
}
/** Read + parse a snapshot file; undefined when missing/corrupt. */
async function readSnapshotFile(file) {
	try {
		return parseSnapshot(JSON.parse(await promises.readFile(file, "utf8")));
	} catch {
		return;
	}
}
/**
* The active template list of one source: the refreshed runtime copy wins, the
* bundled snapshot is the always-available fallback. Memoized per source; a
* successful refresh replaces that source's memo.
*/
async function listTemplates(sourceId = DEFAULT_TEMPLATE_SOURCE_ID) {
	const def = sourceDefOf(sourceId);
	if (def === void 0) throw new Error(`未知的模板库来源：${sourceId}`);
	const memo = memos.get(sourceId);
	if (memo !== void 0) return memo;
	const refreshed = await readSnapshotFile(path.join(REFRESHED_DIR, sourceId, "cases.json")) ?? (def.legacySnapshotPath !== void 0 ? await readSnapshotFile(LEGACY_SNAPSHOT_PATH) : void 0);
	if (refreshed !== void 0) {
		const result = {
			sourceId,
			...refreshed,
			total: refreshed.cases.length,
			origin: "refreshed"
		};
		memos.set(sourceId, result);
		return result;
	}
	const bundled = await readSnapshotFile(def.bundledPath);
	if (bundled !== void 0) {
		const result = {
			sourceId,
			...bundled,
			total: bundled.cases.length,
			origin: "bundled"
		};
		memos.set(sourceId, result);
		return result;
	}
	const result = {
		sourceId,
		cases: [],
		total: 0,
		origin: "bundled",
		repository: "freestylefly/awesome-gpt-image-2",
		fetchedAt: ""
	};
	memos.set(sourceId, result);
	return result;
}
/**
* Re-download one source's case list from its upstream mirror and persist it
* as the runtime copy. Throws with a user-presentable message on failure; the
* previous list (refreshed or bundled) stays active.
*/
async function refreshTemplates(sourceId = DEFAULT_TEMPLATE_SOURCE_ID) {
	const def = sourceDefOf(sourceId);
	if (def === void 0) throw new Error(`未知的模板库来源：${sourceId}`);
	if (def.refreshable === false || def.listUrl === void 0) throw new Error("该模板库为随插件版本更新的内置快照，暂不支持在线刷新");
	let response;
	try {
		response = await fetch(def.listUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
	} catch (error) {
		throw new Error(`无法连接模板库源站（${sourceId}）：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new Error(`模板库源站拒绝请求（HTTP ${response.status}）`);
	let payload;
	try {
		payload = await response.json();
	} catch {
		throw new Error("模板库源站返回了非 JSON 响应");
	}
	const parsed = parseSnapshot(payload);
	if (parsed === void 0) throw new Error("模板库源站数据格式无效");
	const fetchedAt = (/* @__PURE__ */ new Date()).toISOString();
	const snapshot = {
		repository: parsed.repository,
		sourceUrl: def.listUrl,
		fetchedAt,
		totalCases: parsed.cases.length,
		cases: parsed.cases
	};
	const target = path.join(REFRESHED_DIR, sourceId, "cases.json");
	await promises.mkdir(path.dirname(target), { recursive: true });
	const tmp = `${target}.tmp-${process.pid}`;
	await promises.writeFile(tmp, JSON.stringify(snapshot), "utf8");
	await promises.rename(tmp, target);
	const result = {
		sourceId,
		cases: parsed.cases,
		total: parsed.cases.length,
		origin: "refreshed",
		repository: parsed.repository,
		fetchedAt
	};
	memos.set(sourceId, result);
	return {
		sourceId,
		total: parsed.cases.length,
		fetchedAt
	};
}
/** Fisher–Yates shuffle (returns a copy; never mutates the pool). */
function shuffled(items) {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i -= 1) {
		const j = Math.floor(Math.random() * (i + 1));
		const a = out[i];
		out[i] = out[j];
		out[j] = a;
	}
	return out;
}
/**
* Draw up to `count` random cases across every source that has data,
* round-robin between sources so one huge library cannot crowd out the
* others, then shuffle the final pick. Reads memoized lists, so this never
* touches the network — cheap enough for every shuffle click.
*/
async function sampleTemplates(count = 9) {
	const size = Math.min(12, Math.max(1, Math.floor(count) || 9));
	const pools = [];
	for (const source of TEMPLATE_SOURCES) try {
		const list = await listTemplates(source.id);
		if (list.cases.length > 0) pools.push({
			sourceId: source.id,
			cases: shuffled(list.cases)
		});
	} catch {}
	const picks = [];
	for (let round = 0; picks.length < size && pools.some((pool) => pool.cases.length > 0); round += 1) {
		const pool = pools[round % pools.length];
		const picked = pool.cases.pop();
		if (picked !== void 0) picks.push({
			sourceId: pool.sourceId,
			case: picked
		});
	}
	return shuffled(picks);
}
/** Serially refresh every registered source; one failure never stops the rest. */
async function syncAllTemplates() {
	const reports = [];
	for (const source of TEMPLATE_SOURCES) try {
		const def = sourceDefOf(source.id);
		if (def?.refreshable === false || def?.listUrl === void 0) {
			const bundled = await listTemplates(source.id);
			reports.push({
				sourceId: source.id,
				ok: true,
				total: bundled.total
			});
			continue;
		}
		const result = await refreshTemplates(source.id);
		reports.push({
			sourceId: source.id,
			ok: true,
			total: result.total
		});
	} catch (error) {
		reports.push({
			sourceId: source.id,
			ok: false,
			total: 0,
			error: error instanceof Error ? error.message : String(error)
		});
	}
	return reports;
}
/** MIME type for a known image extension; undefined when the name has none. */
function mimeOfFile(file) {
	switch (path.extname(file).toLowerCase()) {
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".png": return "image/png";
		case ".webp": return "image/webp";
		case ".gif": return "image/gif";
		default: return;
	}
}
/** Sniff the five image formats the template proxy serves. */
function sniffImageMime(data) {
	if (data.length >= 3 && data[0] === 255 && data[1] === 216 && data[2] === 255) return "image/jpeg";
	if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([
		137,
		80,
		78,
		71,
		13,
		10,
		26,
		10
	]))) return "image/png";
	if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
	if (data.length >= 6 && (data.subarray(0, 6).toString("ascii") === "GIF87a" || data.subarray(0, 6).toString("ascii") === "GIF89a")) return "image/gif";
}
/** True when an image reference is safe for a specific source. */
function isAllowedImageRef(def, ref) {
	if (!/^https?:\/\//i.test(ref)) return IMAGE_FILE_PATTERN.test(ref) && !ref.includes("..");
	if (ref.length > MAX_IMAGE_URL_LENGTH || ref.includes("..")) return false;
	try {
		const url = new URL(ref);
		return (url.protocol === "http:" || url.protocol === "https:") && url.username === "" && url.password === "" && (def.allowedImageHosts ?? []).includes(url.hostname.toLowerCase());
	} catch {
		return false;
	}
}
/** All upstream URLs to try for one image reference. */
function imageUrlsOf(def, ref) {
	if (/^https?:\/\//i.test(ref)) return (def.imageUrls ?? ((value) => [value]))(ref);
	if (def.imageBaseUrl === void 0) return [];
	return [`${def.imageBaseUrl}${encodeURIComponent(ref)}`];
}
/** Cache file name: legacy bare names stay readable; remote URLs are hashed. */
function cacheFileOf(ref) {
	if (IMAGE_FILE_PATTERN.test(ref) && !ref.includes("..")) return ref;
	let ext = "";
	try {
		const url = new URL(ref);
		ext = path.extname(url.pathname).toLowerCase();
		if (!/^\.[a-z0-9]{2,5}$/.test(ext)) {
			const format = (url.searchParams.get("format") ?? "").toLowerCase();
			ext = [
				"jpg",
				"jpeg",
				"png",
				"webp",
				"gif"
			].includes(format) ? `.${format}` : "";
		}
	} catch {}
	return `${createHash("sha256").update(ref).digest("hex").slice(0, 32)}${ext}`;
}
/** Download one reference image into the source's disk cache; undefined on failure. */
async function fetchTemplateImage(def, ref, cacheFile, cacheDir) {
	for (const url of imageUrlsOf(def, ref)) {
		let response;
		try {
			response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
		} catch {
			continue;
		}
		if (!response.ok) continue;
		if (Number(response.headers.get("content-length") ?? 0) > MAX_IMAGE_BYTES) continue;
		const data = Buffer.from(await response.arrayBuffer());
		if (data.byteLength === 0 || data.byteLength > MAX_IMAGE_BYTES) continue;
		const headerMime = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
		const mime = headerMime !== void 0 && /^image\/(png|jpeg|webp|gif)$/.test(headerMime) ? headerMime : sniffImageMime(data) ?? mimeOfFile(ref);
		if (mime === void 0) continue;
		try {
			await promises.mkdir(cacheDir, { recursive: true });
			const target = path.join(cacheDir, cacheFile);
			const tmp = `${target}.tmp-${process.pid}`;
			await promises.writeFile(tmp, data);
			await promises.rename(tmp, target);
		} catch {}
		return {
			data,
			mime
		};
	}
}
/**
* Read one reference image for a source's library. Cache hit → disk; miss →
* fetch from that source's mirror, cache, and serve. Only file names present
* in the active case list are served, so the route can never act as an open
* proxy. Undefined when the name is unknown or the fetch failed.
*/
async function readTemplateImage(sourceId, file) {
	const def = sourceDefOf(sourceId);
	if (def === void 0) return void 0;
	if (!isAllowedImageRef(def, file)) return void 0;
	if (!(await listTemplates(sourceId)).cases.some((entry) => entry.image === file)) return void 0;
	const cacheDir = path.join(IMAGE_CACHE_ROOT, sourceId);
	const cacheFile = cacheFileOf(file);
	try {
		const data = await promises.readFile(path.join(cacheDir, cacheFile));
		const mime = mimeOfFile(cacheFile) ?? sniffImageMime(data);
		if (mime !== void 0) return {
			data,
			mime
		};
	} catch {}
	if (def.legacyImageDir !== void 0 && IMAGE_FILE_PATTERN.test(file)) try {
		const data = await promises.readFile(path.join(LEGACY_IMAGE_DIR, file));
		const mime = mimeOfFile(file) ?? sniffImageMime(data);
		if (mime !== void 0) return {
			data,
			mime
		};
	} catch {}
	const cacheKey = `${sourceId}/${file}`;
	const inflight = inflightImages.get(cacheKey);
	if (inflight !== void 0) return inflight;
	const pending = fetchTemplateImage(def, file, cacheFile, cacheDir);
	inflightImages.set(cacheKey, pending);
	try {
		return await pending;
	} finally {
		inflightImages.delete(cacheKey);
	}
}
/** Drop the in-memory list memos (tests). */
function clearTemplateMemo() {
	memos.clear();
}
//#endregion
//#region src/template-favorites.ts
/**
* Favorites store for the prompt-template library.
*
* The user's starred templates persist host-side as full case snapshots under
* ~/.dsh/dsh-imagegen/templates/favorites.json, keyed by
* `${sourceId}:${caseId}` — the snapshot means a favorite stays usable even
* after the upstream list drops or renumbers the case. Framework-free
* (node:fs only) so the route layer and tests can drive it directly.
*/
const DATA_DIR = path.join(homedir(), ".dsh", "dsh-imagegen");
const FAVORITES_PATH = path.join(DATA_DIR, "templates", "favorites.json");
/** Refuse to grow the file without bound; the user curates this list. */
const MAX_FAVORITES = 1e3;
/** In-memory memo of the persisted list. */
let memo;
/** Build the stable key of one case within a source. */
function templateFavoriteKey(sourceId, caseId) {
	return `${sourceId}:${caseId}`;
}
/** Validate + normalize one raw stored favorite; undefined when unusable. */
function normalizeFavorite(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const record = raw;
	if (typeof record.key !== "string" || typeof record.savedAt !== "string") return void 0;
	const sourceId = typeof record.sourceId === "string" ? record.sourceId : "";
	if (!isTemplateSourceId(sourceId)) return void 0;
	const rawId = record.case && record.case.id;
	const id = typeof rawId === "number" && Number.isFinite(rawId) ? String(rawId) : typeof rawId === "string" ? rawId.trim() : "";
	if (record.key !== templateFavoriteKey(sourceId, id)) return void 0;
	const rawCase = record.case;
	if (rawCase === null || typeof rawCase !== "object") return void 0;
	const item = rawCase;
	const title = typeof item.title === "string" ? item.title : "";
	const prompt = typeof item.prompt === "string" ? item.prompt : "";
	if (id === "" || title === "" || prompt === "") return void 0;
	const snapshot = {
		id,
		title,
		prompt,
		category: typeof item.category === "string" ? item.category : "",
		categoryZh: typeof item.categoryZh === "string" ? item.categoryZh : "",
		styles: Array.isArray(item.styles) ? item.styles.map(String) : [],
		scenes: Array.isArray(item.scenes) ? item.scenes.map(String) : [],
		sourceLabel: typeof item.sourceLabel === "string" ? item.sourceLabel : "",
		sourceUrl: typeof item.sourceUrl === "string" ? item.sourceUrl : "",
		githubUrl: typeof item.githubUrl === "string" ? item.githubUrl : "",
		image: typeof item.image === "string" ? item.image : "",
		featured: item.featured === true
	};
	return {
		key: record.key,
		sourceId,
		savedAt: record.savedAt,
		case: snapshot
	};
}
/** Read + parse the favorites file (memoized). */
async function listTemplateFavorites() {
	if (memo !== void 0) return memo;
	try {
		const parsed = JSON.parse(await promises.readFile(FAVORITES_PATH, "utf8"));
		memo = Array.isArray(parsed) ? parsed.map(normalizeFavorite).filter((entry) => entry !== void 0) : [];
	} catch {
		memo = [];
	}
	return memo;
}
/** Persist the list atomically and update the memo. */
async function writeFavorites(entries) {
	memo = entries;
	await promises.mkdir(path.dirname(FAVORITES_PATH), { recursive: true });
	const tmp = `${FAVORITES_PATH}.tmp-${process.pid}`;
	await promises.writeFile(tmp, JSON.stringify(entries, null, 2), "utf8");
	await promises.rename(tmp, FAVORITES_PATH);
}
/** Star one template. Re-starring refreshes the snapshot and is idempotent. */
async function addTemplateFavorite(sourceId, item) {
	if (!isTemplateSourceId(sourceId)) throw new Error(`未知的模板库来源：${sourceId}`);
	const key = templateFavoriteKey(sourceId, item.id);
	const rest = (await listTemplateFavorites()).filter((entry) => entry.key !== key);
	const next = [{
		key,
		sourceId,
		savedAt: (/* @__PURE__ */ new Date()).toISOString(),
		case: item
	}, ...rest].slice(0, MAX_FAVORITES);
	await writeFavorites(next);
	return next;
}
/** Unstar one template by key; unknown keys are a no-op. */
async function removeTemplateFavorite(key) {
	const next = (await listTemplateFavorites()).filter((entry) => entry.key !== key);
	if (next.length === memo?.length) return next;
	await writeFavorites(next);
	return next;
}
/** Drop the in-memory memo (tests). */
function clearTemplateFavoritesMemo() {
	memo = void 0;
}
//#endregion
//#region src/updater.ts
/** This copy ships with the desktop source. It does not query or install a published release. */
/** Keep this in sync with package.json for each published release. */
const CURRENT_VERSION = PLUGIN_VERSION;
const PACKAGE_NAME = "@dickpy/dsh-imagegen";
/** Compare stable semver triples; returns positive when `left` is newer. */
function compareVersions(left, right) {
	const parse = (value) => {
		const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
		if (match === null) return [
			0,
			0,
			0
		];
		return [
			Number(match[1]),
			Number(match[2]),
			Number(match[3])
		];
	};
	const a = parse(left);
	const b = parse(right);
	return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}
/** Report the installed source version. A published release must not replace this copy. */
function checkForUpdate() {
	return Promise.resolve({
		currentVersion: CURRENT_VERSION,
		latestVersion: CURRENT_VERSION,
		updateAvailable: false,
		releaseUrl: "https://github.com/dickpy/dsh-imagegen/releases"
	});
}
/** Resolve the profile that launched the current DSH process. */
function profileFromProcess(argv = process.argv, env = process.env) {
	const envProfile = env.DSH_PROFILE?.trim();
	if (envProfile !== void 0 && /^[a-zA-Z0-9_-]+$/.test(envProfile)) return envProfile;
	const profileIndex = argv.indexOf("--profile");
	const explicit = profileIndex >= 0 ? argv[profileIndex + 1]?.trim() : void 0;
	if (explicit !== void 0 && /^[a-zA-Z0-9_-]+$/.test(explicit)) return explicit;
	if (argv.includes("web")) return "web";
	return "web";
}
/** Refuse a release install. The next desktop build carries the maintained source. */
function installUpdate(version) {
	if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) return Promise.reject(/* @__PURE__ */ new Error("invalid update version"));
	return Promise.reject(/* @__PURE__ */ new Error("dsh-imagegen is maintained with the desktop source and cannot be replaced from a release"));
}
/** Kept for callers that used to clear the release cache. There is no cache. */
function clearUpdateCache() {}
//#endregion
//#region src/presets.ts
/**
* Built-in provider catalog (presets). A preset is an official or well-known
* OpenAI-compatible endpoint with its known model list, so the user only fills
* in the API key. The list ships with the package and is served to the
* settings card through a host route, so it can later be refreshed online like
* the template library.
*
* Framework-free (pure data), safe for the host routes to serve directly.
*/
const IMAGE_PRESETS = [
	{
		id: "volc-ark-seedream",
		name: "字节 · 火山方舟（Seedream）",
		apiUrl: "https://ark.cn-beijing.volces.com/api/v3",
		hint: "字节跳动官方 Seedream 文生图/图生图入口",
		models: [
			{
				alias: "seedream-5.0-pro",
				id: "seedream-5.0-pro"
			},
			{
				alias: "seedream-5.0",
				id: "seedream-5.0"
			},
			{
				alias: "seedream-4.0",
				id: "seedream-4.0"
			}
		]
	},
	{
		id: "openai-official",
		name: "OpenAI 官方",
		apiUrl: "https://api.openai.com/v1",
		hint: "OpenAI 官方图像生成接口（gpt-image-2.5 支持手绘草图生图）",
		models: [{
			alias: "gpt-image-2.5",
			id: "gpt-image-2.5"
		}, {
			alias: "gpt-image-2",
			id: "gpt-image-2"
		}]
	},
	{
		id: "zhipu-official",
		name: "智谱 AI 官方",
		apiUrl: "https://open.bigmodel.cn/api/paas/v4",
		hint: "智谱官方 GLM-Image 图像生成接口",
		models: [{
			alias: "glm-image",
			id: "glm-image"
		}]
	},
	{
		id: "aliyun-dashscope-qwen",
		name: "阿里云百炼（Qwen-Image）",
		apiUrl: "https://dashscope.aliyuncs.com/api/v1",
		hint: "阿里云百炼 DashScope 原生接口：通义千问 Qwen-Image 系列（该渠道不可复用于提示词增强）",
		models: [
			{
				alias: "qwen-image-3.0-pro",
				id: "qwen-image-3.0-pro"
			},
			{
				alias: "qwen-image-3.0",
				id: "qwen-image-3.0"
			},
			{
				alias: "qwen-image-2.0-pro",
				id: "qwen-image-2.0-pro"
			},
			{
				alias: "qwen-image-2.0",
				id: "qwen-image-2.0"
			},
			{
				alias: "qwen-image-max",
				id: "qwen-image-max"
			},
			{
				alias: "qwen-image-plus",
				id: "qwen-image-plus"
			},
			{
				alias: "qwen-image",
				id: "qwen-image"
			}
		]
	},
	{
		id: "minimax-official",
		name: "MiniMax 官方（国际站）",
		apiUrl: "https://api.minimax.io/v1",
		hint: "MiniMax 原生 /image_generation 接口：image-01（国内站请把地址改为 https://api.minimaxi.com/v1；/models 不列出图片模型，请直接使用预填目录）",
		models: [{
			alias: "image-01",
			id: "image-01"
		}]
	},
	{
		id: "xai-grok",
		name: "xAI（Grok）",
		apiUrl: "https://api.x.ai/v1",
		hint: "xAI 官方接口：Grok Imagine 系列",
		models: [{
			alias: "grok-imagine-image",
			id: "grok-imagine-image"
		}]
	},
	{
		id: "chatgpt-subscription",
		name: "ChatGPT 订阅（实验）",
		apiUrl: "",
		hint: "浏览器授权登录后使用 gpt-image-2.5-flare；非官方 Codex 图像接口",
		models: [{
			alias: DEFAULT_SUBSCRIPTION_MODELS["chatgpt-sub"],
			id: DEFAULT_SUBSCRIPTION_MODELS["chatgpt-sub"]
		}],
		subscription: "chatgpt-sub",
		experimental: true
	},
	{
		id: "grok-subscription",
		name: "Grok 订阅",
		apiUrl: "",
		hint: "SuperGrok / X Premium 登录后使用 grok-imagine-image-2.0",
		models: [{
			alias: DEFAULT_SUBSCRIPTION_MODELS["grok-sub"],
			id: DEFAULT_SUBSCRIPTION_MODELS["grok-sub"]
		}],
		subscription: "grok-sub"
	},
	{
		id: "google-subscription",
		name: "Google 订阅（实验）",
		apiUrl: "",
		hint: "Google 授权登录后使用 gemini-3-pro-image；非官方 Antigravity 接口",
		models: [{
			alias: DEFAULT_SUBSCRIPTION_MODELS["google-sub"],
			id: DEFAULT_SUBSCRIPTION_MODELS["google-sub"]
		}],
		subscription: "google-sub",
		experimental: true
	},
	{
		id: "openrouter-subscription",
		name: "OpenRouter 账号",
		apiUrl: "",
		hint: "OpenRouter 官方 OAuth 登录，使用 google/gemini-3-pro-image",
		models: [{
			alias: DEFAULT_SUBSCRIPTION_MODELS["openrouter-sub"],
			id: DEFAULT_SUBSCRIPTION_MODELS["openrouter-sub"]
		}],
		subscription: "openrouter-sub"
	}
];
/** Look up one built-in provider by id. */
function presetById(id) {
	return IMAGE_PRESETS.find((preset) => preset.id === id);
}
//#endregion
//#region src/routes.ts
/** Cap on JSON request bodies (settings ops and generate payloads are small). */
const MAX_JSON_BODY_BYTES = 24 * 1024 * 1024;
/** Cap on history append bodies (base64 result images can be much larger). */
const MAX_HISTORY_BODY_BYTES = 64 * 1024 * 1024;
/** Image types the asset route always serves inline (they cannot execute). */
const CANVAS_INLINE_IMAGE_MIME = /^image\/(png|jpeg|webp|gif|bmp)$/;
/**
* The only non-image types `?inline=1` will serve with their real content type:
* the browser's own renderers for documents and media. Anything not listed here
* (HTML, SVG, XML, unknown binaries) keeps coming back as an attachment.
*/
const CANVAS_INLINE_MIME = /^(application\/pdf|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/;
/** Parse one `bytes=a-b` range header; undefined when absent or unsatisfiable. */
function parseByteRange(header, size) {
	const value = Array.isArray(header) ? header[0] : header;
	if (typeof value !== "string" || size <= 0) return void 0;
	const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
	if (match === null) return void 0;
	const [, rawStart = "", rawEnd = ""] = match;
	if (rawStart === "" && rawEnd === "") return void 0;
	let start;
	let end;
	if (rawStart === "") {
		const length = Number(rawEnd);
		if (!Number.isSafeInteger(length) || length <= 0) return void 0;
		start = Math.max(0, size - length);
		end = size - 1;
	} else {
		start = Number(rawStart);
		end = rawEnd === "" ? size - 1 : Number(rawEnd);
		if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return void 0;
		if (start >= size) return void 0;
		end = Math.min(end, size - 1);
	}
	if (end < start) return void 0;
	return {
		start,
		end
	};
}
/** Loopback literal check plus browser same-origin markers (mirrors dsh-ssh). */
function isLoopbackRequest(request) {
	const address = request.socket.remoteAddress;
	if (address !== "127.0.0.1" && address !== "::1" && address !== "::ffff:127.0.0.1") return false;
	const host = request.headers.host;
	if (typeof host !== "string") return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== "127.0.0.1" && hostUrl.hostname !== "localhost" && hostUrl.hostname !== "[::1]") return false;
	if (request.headers["sec-fetch-site"] === "cross-site") return false;
	const origin = request.headers.origin;
	if (origin === void 0) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}
/** One JSON response. */
function writeJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"referrer-policy": "no-referrer"
	});
	res.end(payload);
}
/** Read a JSON request body (undefined when too large or unparseable). */
async function readJsonBody(req, maxBytes = MAX_JSON_BODY_BYTES) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > maxBytes) return void 0;
		chunks.push(buffer);
	}
	try {
		const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		return typeof parsed === "object" && parsed !== null ? parsed : void 0;
	} catch {
		return;
	}
}
/** Read a raw request body (the canvas file upload path; no base64 inflation). */
async function readRawBody(req, maxBytes) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = chunk;
		size += buffer.length;
		if (size > maxBytes) return void 0;
		chunks.push(buffer);
	}
	return Buffer.concat(chunks);
}
/** Human-readable text from an unknown thrown value. */
function messageOf$2(error) {
	return error instanceof Error ? error.message : String(error);
}
/** Validate the { source } body of a template-library request. */
function templateSourceOf(body) {
	const raw = body?.source;
	if (raw === void 0 || raw === "") return DEFAULT_TEMPLATE_SOURCE_ID;
	return typeof raw === "string" && isTemplateSourceId(raw) ? raw : void 0;
}
/** Validate the body of a canvas skill run (projected from the browser). */
function parseSkillRunRequest(body) {
	const canvasId = typeof body?.canvasId === "string" ? body.canvasId.trim() : "";
	const skillId = typeof body?.skillId === "string" ? body.skillId.trim() : "";
	if (canvasId === "" || skillId === "") return void 0;
	const nodeIds = Array.isArray(body?.nodeIds) ? [...new Set(body.nodeIds.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item !== ""))] : [];
	const instruction = typeof body?.instruction === "string" ? body.instruction : void 0;
	const params = {};
	if (body?.params !== null && typeof body?.params === "object" && !Array.isArray(body.params)) {
		for (const [key, value] of Object.entries(body.params)) if (typeof value === "string") params[key] = value;
	}
	return {
		canvasId,
		skillId,
		nodeIds,
		...instruction === void 0 ? {} : { instruction },
		...Object.keys(params).length === 0 ? {} : { params },
		placement: body?.placement === "below" ? "below" : "right",
		...parseSkillLanguage(body)
	};
}
/** The UI language hint every skill route accepts (copy stays translated). */
function parseSkillLanguage(body) {
	const raw = typeof body?.language === "string" ? body.language.trim().toLowerCase() : "";
	return raw === "zh" || raw === "en" || raw === "ru" ? { language: raw } : {};
}
/**
* Normalize one skill-library install request: sources are trimmed, de-duped
* URLs, and the uploaded archive is taken from an asset reference the canvas
* upload route already stored (the host never sees raw browser bytes twice).
*/
function parseSkillInstallRequest(body) {
	const raw = Array.isArray(body?.sources) ? body.sources : [];
	const sources = [...new Set(raw.filter((item) => typeof item === "string").map((item) => item.trim()).filter((item) => item !== ""))].slice(0, 10);
	const asset = body?.asset !== null && typeof body?.asset === "object" && !Array.isArray(body.asset) ? body.asset : void 0;
	if (sources.length === 0 && asset === void 0) return void 0;
	const name = typeof body?.name === "string" ? body.name.trim() : "";
	return {
		...sources.length === 0 ? {} : { sources },
		...asset === void 0 ? {} : { asset },
		...name === "" ? {} : { name },
		force: body?.force === true,
		...parseSkillLanguage(body)
	};
}
function parseGenerateRequest(body) {
	const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
	if (prompt === "") return void 0;
	const comparisonModels = Array.isArray(body.comparisonModels) ? [...new Set(body.comparisonModels.filter((model) => typeof model === "string").map((model) => model.trim()).filter(Boolean))] : [];
	const canvas = parseCanvasMeta(body.canvas);
	return {
		mode: body.mode === "edit" ? "edit" : "text",
		model: typeof body.model === "string" ? body.model : "",
		prompt,
		size: typeof body.size === "string" ? body.size : "auto",
		quality: typeof body.quality === "string" ? body.quality : "auto",
		n: typeof body.n === "number" ? body.n : 1,
		detail: typeof body.detail === "string" ? body.detail : "",
		...typeof body.image === "string" && body.image !== "" ? { image: body.image } : {},
		...Array.isArray(body.images) ? { images: body.images.filter((item) => typeof item === "string" && item !== "").slice(0, 4) } : {},
		...typeof body.refName === "string" && body.refName !== "" ? { refName: body.refName } : {},
		...typeof body.channelId === "string" && body.channelId !== "" ? { channelId: body.channelId } : {},
		...typeof body.comparisonId === "string" && body.comparisonId !== "" ? { comparisonId: body.comparisonId } : {},
		...comparisonModels.length > 1 ? { comparisonModels } : {},
		...canvas === void 0 ? {} : { canvas },
		...body.workflow === "ecommerce" ? { workflow: "ecommerce" } : {},
		...typeof body.projectId === "string" && body.projectId !== "" ? { projectId: body.projectId } : {},
		...typeof body.projectName === "string" && body.projectName !== "" ? { projectName: body.projectName } : {},
		...typeof body.slotKey === "string" && body.slotKey !== "" ? { slotKey: body.slotKey } : {},
		...typeof body.slotLabel === "string" && body.slotLabel !== "" ? { slotLabel: body.slotLabel } : {}
	};
}
function parseCanvasMeta(value) {
	if (value === null || typeof value !== "object") return void 0;
	const raw = value;
	if (typeof raw.canvasId !== "string" || raw.canvasId.trim() === "") return void 0;
	return {
		canvasId: raw.canvasId.trim(),
		...typeof raw.sourceNodeId === "string" && raw.sourceNodeId.trim() !== "" ? { sourceNodeId: raw.sourceNodeId.trim() } : {},
		...typeof raw.annotationNodeId === "string" && raw.annotationNodeId.trim() !== "" ? { annotationNodeId: raw.annotationNodeId.trim() } : {},
		...typeof raw.parentNodeId === "string" && raw.parentNodeId.trim() !== "" ? { parentNodeId: raw.parentNodeId.trim() } : {},
		...raw.placement === "right" || raw.placement === "below" ? { placement: raw.placement } : {}
	};
}
/** Validate a submitted history entry (images carry base64). */
function parseHistoryEntryInput(body) {
	const raw = body.entry;
	if (raw === null || typeof raw !== "object") return void 0;
	const entry = raw;
	if (typeof entry.id !== "string" || typeof entry.createdAt !== "number") return void 0;
	if (entry.mode !== "text" && entry.mode !== "edit") return void 0;
	if (typeof entry.model !== "string" || typeof entry.prompt !== "string") return void 0;
	if (typeof entry.size !== "string" || typeof entry.quality !== "string" || typeof entry.detail !== "string") return void 0;
	if (typeof entry.n !== "number") return void 0;
	if (!Array.isArray(entry.images)) return void 0;
	const images = [];
	for (const item of entry.images) {
		if (item === null || typeof item !== "object") return void 0;
		const image = item;
		if (typeof image.b64 !== "string" || typeof image.mime !== "string") return void 0;
		images.push({
			b64: image.b64,
			mime: image.mime,
			...typeof image.revisedPrompt === "string" ? { revisedPrompt: image.revisedPrompt } : {}
		});
	}
	const comparisonModels = Array.isArray(entry.comparisonModels) ? [...new Set(entry.comparisonModels.filter((model) => typeof model === "string").map((model) => model.trim()).filter(Boolean))] : [];
	const canvas = parseCanvasMeta(entry.canvas);
	return {
		id: entry.id,
		createdAt: entry.createdAt,
		mode: entry.mode,
		model: entry.model,
		prompt: entry.prompt,
		size: entry.size,
		quality: entry.quality,
		detail: entry.detail,
		n: entry.n,
		images,
		...typeof entry.refName === "string" ? { refName: entry.refName } : {},
		...typeof entry.channelId === "string" ? { channelId: entry.channelId } : {},
		...typeof entry.channel === "string" ? { channel: entry.channel } : {},
		...typeof entry.comparisonId === "string" ? { comparisonId: entry.comparisonId } : {},
		...comparisonModels.length > 1 ? { comparisonModels } : {},
		...canvas === void 0 ? {} : { canvas },
		...entry.workflow === "ecommerce" ? { workflow: "ecommerce" } : {},
		...typeof entry.projectId === "string" ? { projectId: entry.projectId } : {},
		...typeof entry.projectName === "string" ? { projectName: entry.projectName } : {},
		...typeof entry.slotKey === "string" ? { slotKey: entry.slotKey } : {},
		...typeof entry.slotLabel === "string" ? { slotLabel: entry.slotLabel } : {}
	};
}
/** Extract the image file name from a history-image request URL. */
function imageFileFrom(rawUrl, basePath) {
	if (rawUrl === void 0) return void 0;
	let pathname;
	try {
		pathname = new URL(rawUrl, "http://localhost").pathname;
	} catch {
		return;
	}
	if (!pathname.startsWith(`${basePath}/`)) return void 0;
	return decodeURIComponent(pathname.slice(basePath.length + 1));
}
/** Parse the durable image reference carried by an Agent tool-result view. */
function agentImageRefFrom(rawUrl) {
	if (rawUrl === void 0) return void 0;
	let url;
	try {
		url = new URL(rawUrl, "http://localhost");
	} catch {
		return;
	}
	if (url.pathname !== "/api/dsh-imagegen/agent-image") return void 0;
	const attachmentId = url.searchParams.get("attachment_id") ?? "";
	const mediaType = url.searchParams.get("media_type") ?? "";
	const bytes = Number(url.searchParams.get("bytes"));
	const width = Number(url.searchParams.get("width"));
	const height = Number(url.searchParams.get("height"));
	if (attachmentId === "" || !isImageMediaType(mediaType) || !Number.isSafeInteger(bytes) || bytes < 1 || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) return void 0;
	return {
		attachmentId,
		mediaType,
		bytes,
		width,
		height
	};
}
function isImageMediaType(value) {
	return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}
function imageDataUrl$1(value) {
	const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.*)$/su.exec(value.trim());
	if (match === null || match[1] === void 0 || match[2] === void 0) return void 0;
	const data = Buffer.from(match[2], "base64");
	return data.byteLength === 0 ? void 0 : {
		mediaType: match[1],
		data
	};
}
/** Project one settings descriptor onto the bridge wire view. */
function toView(descriptor, namespace = String(descriptor.ns)) {
	return {
		ns: namespace,
		schema: descriptor.schema,
		value: descriptor.value,
		...descriptor.base === void 0 ? {} : { base: descriptor.base },
		...descriptor.user === void 0 ? {} : { user: descriptor.user },
		...descriptor.secrets === void 0 ? {} : { secrets: descriptor.secrets.map((secret) => ({
			path: [...secret.path],
			set: secret.set
		})) },
		revision: descriptor.revision
	};
}
/** Map a subscription provider to its manager vendor id. */
function vendorOfSubscription(provider) {
	if (provider === "chatgpt-sub") return "codex";
	if (provider === "google-sub") return "antigravity";
	if (provider === "openrouter-sub") return "openrouter";
	return "grok";
}
/** Map a seam failure onto the bridge refusal envelope. */
function failureOf(error) {
	if (error instanceof SettingsConflictError) return {
		ok: false,
		code: "settings-conflict",
		message: error.message
	};
	return {
		ok: false,
		code: "settings-rejected",
		message: error instanceof Error ? error.message : String(error)
	};
}
/**
* Build every /api/dsh-imagegen route.
* @param deps - settings seam + config resolver.
* @returns the route registrations.
*/
function makeRoutes(deps) {
	const history = deps.history ?? {
		list: listHistory,
		append: appendHistory,
		remove: removeHistory,
		clear: clearHistory,
		readImage: readHistoryImage
	};
	const gallery = deps.gallery ?? {
		list: listGallery,
		append: appendGallery,
		remove: removeGallery,
		clear: clearGallery,
		updateTags: updateGalleryTags,
		readImage: readGalleryImage
	};
	const canvas = deps.canvas ?? canvasStore;
	const templates = deps.templates ?? {
		list: listTemplates,
		refresh: refreshTemplates,
		sample: sampleTemplates,
		readImage: readTemplateImage
	};
	const favorites = deps.favorites ?? {
		list: listTemplateFavorites,
		add: addTemplateFavorite,
		remove: removeTemplateFavorite
	};
	const resolvePrompt = deps.resolvePrompt ?? (() => ({
		apiUrl: "",
		apiKey: "",
		model: ""
	}));
	const resolveImageModels = deps.resolveImageModels ?? (() => normalizeImageModels(void 0));
	const requestedNamespace = deps.settingsNamespace ?? "dsh-imagegen";
	const settingsNamespace = () => {
		const rows = deps.settings.describe({ redactSecrets: true });
		if (rows.some((row) => String(row.ns) === requestedNamespace)) return requestedNamespace;
		if (rows.some((row) => String(row.ns) === "imagegen")) return "imagegen";
		return requestedNamespace;
	};
	/** The current channel view: the channel-aware resolver, or a synthesized
	*  single default channel from the legacy flat upstream config (tests and
	*  older hosts). */
	const channelViewOf = () => {
		if (deps.resolveChannels !== void 0) return deps.resolveChannels();
		const upstream = deps.resolve();
		const models = normalizeImageModels(resolveImageModels()).map((id) => ({
			alias: id,
			id
		}));
		if (upstream.apiUrl.trim() === "" && models.length === 0) return {
			channels: [],
			defaultChannelId: ""
		};
		return {
			channels: [{
				id: "default",
				preset: "",
				name: "默认渠道",
				apiUrl: upstream.apiUrl,
				apiUrlFull: false,
				apiKey: upstream.apiKey,
				models
			}],
			defaultChannelId: "default"
		};
	};
	const runtime = deps.runtime ?? new ImageGenerationRuntime(channelViewOf, history);
	/** Resolve an alias (or the channel fallback) into a concrete generation
	*  request: picks the channel (explicit then default), maps alias → upstream
	*  id, and fills the channel snapshot kept on history entries. */
	const resolveChannelRequest = (request) => {
		const view = channelViewOf();
		if (view.channels.length === 0) return {
			ok: false,
			code: "no-channels",
			message: "尚未配置任何渠道：请先打开「设置 → 生图配置」添加渠道并填写 API 地址与密钥"
		};
		const explicit = view.channels.find((candidate) => candidate.id === request.channelId);
		const defaults = view.channels.find((candidate) => candidate.id === view.defaultChannelId) ?? view.channels[0];
		const target = explicit ?? defaults;
		const asked = request.model.trim();
		if (asked === "") {
			const alias = target?.models[0]?.alias ?? "";
			if (alias === "") return {
				ok: false,
				code: "no-models",
				message: `渠道「${target?.name ?? ""}」尚未配置模型，请先在设置中添加`
			};
			const mapping = target.models.find((model) => model.alias === alias);
			return {
				ok: true,
				request: {
					...request,
					model: alias,
					upstream: mapping.id,
					channelId: target.id,
					channel: target.name
				}
			};
		}
		const hosting = view.channels.filter((channel) => channel.models.some((model) => model.alias === asked));
		if (hosting.length === 0) return {
			ok: false,
			code: "image-model-not-configured",
			message: `模型「${asked}」未在任一渠道配置；可用模型：${[...new Set(view.channels.flatMap((channel) => channel.models.map((model) => model.alias)))].join("、") || "（无）"}`
		};
		const picked = target !== void 0 && target.models.some((model) => model.alias === asked) ? target : hosting[0];
		const mapping = picked.models.find((model) => model.alias === asked);
		return {
			ok: true,
			request: {
				...request,
				model: asked,
				upstream: mapping.id,
				channelId: picked.id,
				channel: picked.name
			}
		};
	};
	const guard = (req, res, method) => {
		if (!isLoopbackRequest(req)) {
			writeJson(res, 403, { error: "forbidden: loopback-only" });
			return false;
		}
		if (req.method !== method) {
			writeJson(res, 405, { error: `method not allowed: ${req.method}` });
			return false;
		}
		return true;
	};
	return [
		...deps.attachments?.saveImage === void 0 || deps.pendingConversationImages === void 0 ? [] : [{
			kind: "exact",
			path: CONVERSATION_IMAGE_API,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req, MAX_JSON_BODY_BYTES);
				const sessionId = typeof body?.sessionId === "string" ? body.sessionId.trim() : "";
				const dataUrl = typeof body?.dataUrl === "string" ? imageDataUrl$1(body.dataUrl) : void 0;
				if (sessionId === "" || dataUrl === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "sessionId and image data are required"
					});
					return;
				}
				try {
					const ref = await deps.attachments.saveImage({
						data: dataUrl.data,
						mediaType: dataUrl.mediaType,
						...typeof body?.name === "string" && body.name.trim() !== "" ? { name: body.name.trim() } : {}
					});
					deps.pendingConversationImages.set(sessionId, ref);
					writeJson(res, 200, { ok: true });
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "image-save-failed",
						message: messageOf$2(error)
					});
				}
			}
		}],
		...deps.attachments === void 0 ? [] : [{
			kind: "prefix",
			path: AGENT_IMAGE_API,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const ref = agentImageRefFrom(req.url);
				if (ref === void 0) {
					writeJson(res, 400, { error: "invalid image reference" });
					return;
				}
				try {
					const stored = await deps.attachments.readImage(ref);
					res.writeHead(200, {
						"content-type": stored.ref.mediaType,
						"content-length": stored.data.byteLength,
						"cache-control": "private, max-age=3600"
					});
					res.end(Buffer.from(stored.data));
				} catch {
					writeJson(res, 404, { error: "image attachment not found" });
				}
			}
		}],
		{
			kind: "exact",
			path: IMAGE_MODEL_API.models,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const view = channelViewOf();
				const stored = view.channels.find((candidate) => candidate.id === (typeof body?.channelId === "string" ? body.channelId : void 0)) ?? view.channels.find((candidate) => candidate.id === view.defaultChannelId) ?? view.channels[0];
				const protocol = isChannelProtocolPreference(body?.protocol) ? body.protocol : stored?.protocol;
				const upstream = {
					apiUrl: typeof body?.apiUrl === "string" && body.apiUrl.trim() !== "" ? body.apiUrl.trim() : stored?.apiUrl ?? "",
					apiKey: typeof body?.apiKey === "string" && body.apiKey.trim() !== "" ? body.apiKey.trim() : stored?.apiKey ?? "",
					apiUrlFull: typeof body?.apiUrlFull === "boolean" ? body.apiUrlFull : stored?.apiUrlFull === true,
					...protocol === void 0 ? {} : { protocol }
				};
				try {
					writeJson(res, 200, {
						ok: true,
						models: await listImageModels(upstream)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "image-models-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: PRESETS_API,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				writeJson(res, 200, {
					ok: true,
					presets: IMAGE_PRESETS.map((preset) => ({
						id: preset.id,
						name: preset.name,
						apiUrl: preset.apiUrl,
						hint: preset.hint,
						models: preset.models,
						...preset.subscription === void 0 ? {} : { subscription: preset.subscription },
						...preset.experimental === void 0 ? {} : { experimental: preset.experimental }
					}))
				});
			}
		},
		{
			kind: "exact",
			path: USAGE_API,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					const entries = [...await history.list(), ...await gallery.list()];
					const byChannel = {};
					const totals = {};
					for (const entry of entries) {
						const channelKey = entry.channelId !== void 0 ? entry.channelId : entry.channel !== void 0 ? `name:${entry.channel}` : "";
						const alias = entry.model;
						const bucket = byChannel[channelKey] ?? (byChannel[channelKey] = {});
						bucket[alias] = (bucket[alias] ?? 0) + 1;
						totals[alias] = (totals[alias] ?? 0) + 1;
					}
					writeJson(res, 200, {
						ok: true,
						usage: {
							byChannel,
							totals
						}
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "usage-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: PROMPT_ENHANCE_API.models,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson(res, 200, {
						ok: true,
						models: await listPromptModels(resolvePrompt())
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "prompt-models-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: PROMPT_ENHANCE_API.enhance,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
				if (prompt === "") {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "prompt is required"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						prompt: body?.mode === "polish" ? await polishPrompt(resolvePrompt(), prompt) : await enhancePrompt(resolvePrompt(), prompt)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "prompt-enhance-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: SETTINGS_API.describe,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const descriptor = deps.settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === settingsNamespace());
				writeJson(res, 200, {
					ok: true,
					value: {
						namespaces: descriptor === void 0 ? [] : [toView(descriptor, IMAGEGEN_SETTINGS_NAMESPACE)],
						writable: deps.settings.writable !== false
					}
				});
			}
		},
		{
			kind: "exact",
			path: SETTINGS_API.mutate,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (body === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "settings-rejected",
						message: "unreadable JSON body"
					});
					return;
				}
				if ((typeof body.ns === "string" ? body.ns : "") !== "dsh-imagegen" || !Array.isArray(body.ops)) {
					writeJson(res, 200, {
						ok: false,
						code: "settings-rejected",
						message: "malformed bridge settings request"
					});
					return;
				}
				const expectedRevision = typeof body.expectedRevision === "number" ? body.expectedRevision : void 0;
				try {
					await deps.settings.mutate(settingsNamespace(), body.ops, expectedRevision);
				} catch (error) {
					writeJson(res, 200, failureOf(error));
					return;
				}
				const descriptor = deps.settings.describe({ redactSecrets: true }).find((candidate) => String(candidate.ns) === settingsNamespace());
				if (descriptor === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "internal",
						message: `settings namespace "${settingsNamespace()}" was disposed after the mutate`
					});
					return;
				}
				writeJson(res, 200, {
					ok: true,
					value: toView(descriptor, IMAGEGEN_SETTINGS_NAMESPACE)
				});
			}
		},
		{
			kind: "exact",
			path: GENERATE_API,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const parsed = body === void 0 ? void 0 : parseGenerateRequest(body);
				if (parsed === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "prompt is required"
					});
					return;
				}
				const resolved = resolveChannelRequest(parsed);
				if (!resolved.ok) {
					writeJson(res, 200, {
						ok: false,
						code: resolved.code,
						message: resolved.message
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						...await runtime.run(resolved.request)
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					writeJson(res, 200, {
						ok: false,
						code: error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "generate-failed",
						message
					});
				}
			}
		},
		{
			kind: "exact",
			path: TASK_API.submit,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const parsed = body === void 0 ? void 0 : parseGenerateRequest(body);
				if (parsed === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "prompt is required"
					});
					return;
				}
				const resolved = resolveChannelRequest(parsed);
				if (!resolved.ok) {
					writeJson(res, 200, {
						ok: false,
						code: resolved.code,
						message: resolved.message
					});
					return;
				}
				writeJson(res, 200, {
					ok: true,
					task: runtime.queue.submit(resolved.request)
				});
			}
		},
		{
			kind: "exact",
			path: TASK_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				writeJson(res, 200, {
					ok: true,
					tasks: runtime.queue.summaries()
				});
			}
		},
		{
			kind: "exact",
			path: DIAGNOSTICS_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				writeJson(res, 200, {
					ok: true,
					entries: listDiagnostics()
				});
			}
		},
		{
			kind: "exact",
			path: DIAGNOSTICS_API.clear,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				clearDiagnostics();
				writeJson(res, 200, { ok: true });
			}
		},
		{
			kind: "exact",
			path: TASK_API.get,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const task = typeof body?.id === "string" ? runtime.queue.get(body.id) : void 0;
				if (task === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "not-found",
						message: "task not found"
					});
					return;
				}
				writeJson(res, 200, {
					ok: true,
					task
				});
			}
		},
		{
			kind: "exact",
			path: TASK_API.cancel,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const task = typeof body?.id === "string" ? runtime.queue.cancel(body.id) : void 0;
				if (task === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "not-found",
						message: "task not found"
					});
					return;
				}
				writeJson(res, 200, {
					ok: true,
					task
				});
			}
		},
		{
			kind: "exact",
			path: TASK_API.retry,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const task = typeof body?.id === "string" ? runtime.queue.retry(body.id) : void 0;
				if (task === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "not-found",
						message: "task not found"
					});
					return;
				}
				writeJson(res, 200, {
					ok: true,
					task
				});
			}
		},
		{
			kind: "exact",
			path: UPDATE_API.check,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson(res, 200, {
						ok: true,
						update: await checkForUpdate()
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "update-check-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: UPDATE_API.apply,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				writeJson(res, 200, {
					ok: false,
					code: "update-not-available",
					message: "dsh-imagegen is maintained with the desktop source and is not updated from a release"
				});
			}
		},
		...deps.subscriptions === void 0 ? [] : [{
			kind: "exact",
			path: SUBSCRIPTION_API.status,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const statuses = {};
				for (const provider of SUBSCRIPTION_PROVIDERS) {
					const vendor = vendorOfSubscription(provider);
					const status = await deps.subscriptions.loginStatus(vendor);
					const error = deps.subscriptions.lastLoginError(vendor);
					statuses[provider] = status.state === "logged-in" ? {
						state: status.state,
						email: status.email
					} : {
						state: status.state,
						...error === void 0 ? {} : { error }
					};
				}
				writeJson(res, 200, {
					ok: true,
					statuses
				});
			}
		}, {
			kind: "exact",
			path: SUBSCRIPTION_API.login,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const provider = typeof body?.provider === "string" ? body.provider : "";
				if (!SUBSCRIPTION_PROVIDERS.includes(provider)) {
					writeJson(res, 200, {
						ok: false,
						code: "invalid-provider",
						message: "unknown subscription provider"
					});
					return;
				}
				const vendor = vendorOfSubscription(provider);
				try {
					if (body?.action === "logout") {
						await deps.subscriptions.logout(vendor);
						writeJson(res, 200, { ok: true });
						return;
					}
					if (body?.action === "complete") {
						const input = typeof body.input === "string" ? body.input : "";
						await deps.subscriptions.completeLogin(vendor, input);
						writeJson(res, 200, { ok: true });
						return;
					}
					writeJson(res, 200, {
						ok: true,
						...await deps.subscriptions.beginLogin(vendor)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "subscription-login-failed",
						message: messageOf$2(error)
					});
				}
			}
		}],
		{
			kind: "exact",
			path: HISTORY_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson(res, 200, {
						ok: true,
						entries: await history.list()
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "history-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: HISTORY_API.append,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req, MAX_HISTORY_BODY_BYTES);
				if (body === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "unreadable JSON body"
					});
					return;
				}
				const entry = parseHistoryEntryInput(body);
				if (entry === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "malformed history entry"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						entries: await history.append(entry)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "history-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: HISTORY_API.remove,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const id = body !== void 0 && typeof body.id === "string" ? body.id : "";
				if (id === "") {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "history id is required"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						entries: await history.remove(id)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "history-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: HISTORY_API.clear,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson(res, 200, {
						ok: true,
						entries: await history.clear()
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "history-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "prefix",
			path: HISTORY_API.image,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const file = imageFileFrom(req.url, HISTORY_API.image);
				if (file === void 0) {
					writeJson(res, 404, { error: "not found" });
					return;
				}
				const found = await history.readImage(file);
				if (found === void 0) {
					writeJson(res, 404, { error: "not found" });
					return;
				}
				res.writeHead(200, {
					"content-type": found.mime,
					"content-length": found.data.length,
					"cache-control": "private, max-age=3600"
				});
				res.end(found.data);
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson(res, 200, {
						ok: true,
						entries: await gallery.list()
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.append,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req, MAX_HISTORY_BODY_BYTES);
				if (body === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "unreadable JSON body"
					});
					return;
				}
				const entry = parseHistoryEntryInput(body);
				if (entry === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "malformed gallery entry"
					});
					return;
				}
				try {
					const result = await gallery.append({
						...entry,
						id: randomUUID()
					});
					writeJson(res, 200, {
						ok: true,
						entries: result.entries,
						added: result.added
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.remove,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const id = body !== void 0 && typeof body.id === "string" ? body.id : "";
				if (id === "") {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "gallery id is required"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						entries: await gallery.remove(id)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.tags,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const id = typeof body?.id === "string" ? body.id : "";
				const tags = Array.isArray(body?.tags) ? body.tags.filter((tag) => typeof tag === "string") : void 0;
				if (id === "" || tags === void 0 || gallery.updateTags === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "gallery id and tags are required"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						entries: await gallery.updateTags(id, tags)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: GALLERY_API.clear,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson(res, 200, {
						ok: true,
						entries: await gallery.clear()
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "gallery-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "prefix",
			path: GALLERY_API.image,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const file = imageFileFrom(req.url, GALLERY_API.image);
				if (file === void 0) {
					writeJson(res, 404, { error: "not found" });
					return;
				}
				const found = await gallery.readImage(file);
				if (found === void 0) {
					writeJson(res, 404, { error: "not found" });
					return;
				}
				res.writeHead(200, {
					"content-type": found.mime,
					"content-length": found.data.length,
					"cache-control": "private, max-age=3600"
				});
				res.end(found.data);
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson(res, 200, {
						ok: true,
						projects: await canvas.list()
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "canvas-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.create,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const title = typeof body?.title === "string" ? body.title : "未命名画布";
				try {
					writeJson(res, 200, {
						ok: true,
						document: await canvas.create(title)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "canvas-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.read,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const id = typeof body?.id === "string" ? body.id : "";
				const document = id === "" ? void 0 : await canvas.read(id);
				if (document === void 0) writeJson(res, 200, {
					ok: false,
					code: "not-found",
					message: "画布不存在"
				});
				else writeJson(res, 200, {
					ok: true,
					document
				});
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.save,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const document = body?.document;
				const expectedRevision = typeof body?.expectedRevision === "number" ? body.expectedRevision : void 0;
				if (document === void 0 || typeof document !== "object") {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "canvas document is required"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						document: await canvas.save(document, expectedRevision)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: error instanceof CanvasConflictError ? error.code : "canvas-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.remove,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const id = typeof body?.id === "string" ? body.id : "";
				if (id === "") {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "canvas id is required"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						projects: await canvas.remove(id)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "canvas-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.favorite,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const id = typeof body?.id === "string" ? body.id.trim() : "";
				const favorite = body?.favorite === true;
				if (id === "") {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "canvas id is required"
					});
					return;
				}
				if (canvas.setFavorite === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "canvas-favorite-unsupported",
						message: "当前画布后端不支持收藏"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						projects: await canvas.setFavorite(id, favorite)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "canvas-favorite-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.assetUpload,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req, MAX_HISTORY_BODY_BYTES);
				const parsed = typeof body?.dataUrl === "string" ? imageDataUrl$1(body.dataUrl) : void 0;
				const width = Number(body?.width);
				const height = Number(body?.height);
				if (parsed === void 0 || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "image data and dimensions are required"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						asset: await canvas.putImage({
							data: parsed.data,
							mime: parsed.mediaType,
							width,
							height,
							origin: body?.origin === "history" || body?.origin === "gallery" || body?.origin === "generated" ? body.origin : "upload",
							...typeof body?.originId === "string" ? { originId: body.originId } : {},
							...typeof body?.entryId === "string" ? { entryId: body.entryId } : {},
							...Number.isSafeInteger(Number(body?.imageIndex)) ? { imageIndex: Number(body?.imageIndex) } : {}
						})
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "canvas-asset-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.assetImport,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const source = body?.source === "history" || body?.source === "gallery" ? body.source : void 0;
				const entryId = typeof body?.entryId === "string" ? body.entryId : "";
				const imageIndex = Number(body?.imageIndex);
				const width = Number(body?.width);
				const height = Number(body?.height);
				if (source === void 0 || entryId === "" || !Number.isSafeInteger(imageIndex) || imageIndex < 0 || !Number.isSafeInteger(width) || width < 1 || !Number.isSafeInteger(height) || height < 1) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "source, entryId, imageIndex and dimensions are required"
					});
					return;
				}
				try {
					const backend = source === "history" ? history : gallery;
					const image = (await backend.list()).find((item) => item.id === entryId)?.images[imageIndex];
					if (image === void 0) {
						writeJson(res, 200, {
							ok: false,
							code: "not-found",
							message: "image not found"
						});
						return;
					}
					const base = source === "history" ? HISTORY_API.image : GALLERY_API.image;
					const file = imageFileFrom(image.url, base);
					const found = file === void 0 ? void 0 : await backend.readImage(file);
					if (found === void 0) {
						writeJson(res, 200, {
							ok: false,
							code: "not-found",
							message: "image not found"
						});
						return;
					}
					writeJson(res, 200, {
						ok: true,
						asset: await canvas.putImage({
							data: found.data,
							mime: found.mime,
							width,
							height,
							origin: source,
							originId: entryId,
							entryId,
							imageIndex
						})
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "canvas-asset-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.layers,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const raw = typeof body?.image === "string" ? body.image.trim() : "";
				const image = raw === "" ? void 0 : imageDataUrl$1(raw);
				if (image === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "image data URL is required"
					});
					return;
				}
				if (image.data.byteLength > 12582912) {
					writeJson(res, 200, {
						ok: false,
						code: "image-too-large",
						message: "图片超过 12MB 上限，请先压缩后再拆分图层"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						plan: await analyzeLayers(resolvePrompt(), raw)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "layer-analysis-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "prefix",
			path: CANVAS_API.asset,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const file = imageFileFrom(req.url, CANVAS_API.asset);
				const found = file === void 0 ? void 0 : await canvas.readAsset(file);
				if (found === void 0) {
					writeJson(res, 404, { error: "not found" });
					return;
				}
				const url = new URL(req.url ?? "/", "http://127.0.0.1");
				const image = CANVAS_INLINE_IMAGE_MIME.test(found.mime);
				const wantsInline = url.searchParams.get("inline") === "1";
				const downloadRequested = url.searchParams.get("download") === "0";
				if (!(image && !downloadRequested || wantsInline && CANVAS_INLINE_MIME.test(found.mime))) {
					res.writeHead(200, {
						"content-type": "application/octet-stream",
						"content-length": found.data.length,
						"cache-control": "private, no-store",
						"x-content-type-options": "nosniff",
						"content-disposition": `attachment; filename="${file ?? "asset"}"`
					});
					res.end(found.data);
					return;
				}
				const headers = {
					"content-type": found.mime,
					"cache-control": "private, max-age=3600",
					"x-content-type-options": "nosniff",
					"content-disposition": `inline; filename="${file ?? "asset"}"`,
					"accept-ranges": "bytes"
				};
				const range = parseByteRange(req.headers.range, found.data.length);
				if (range !== void 0) {
					const slice = found.data.subarray(range.start, range.end + 1);
					res.writeHead(206, {
						...headers,
						"content-range": `bytes ${range.start}-${range.end}/${found.data.length}`,
						"content-length": slice.length
					});
					res.end(slice);
					return;
				}
				res.writeHead(200, {
					...headers,
					"content-length": found.data.length
				});
				res.end(found.data);
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.fileUpload,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				if (canvas.putFile === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "canvas-files-unsupported",
						message: "当前画布后端不支持文件资产"
					});
					return;
				}
				const name = safeFileName(new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("name") ?? "file");
				const header = req.headers["content-type"];
				const declared = typeof header === "string" ? header : "";
				const mime = declared.trim() === "" ? mimeFromFileName(name) : declared;
				const data = await readRawBody(req, MAX_CANVAS_FILE_BYTES);
				if (data === void 0 || data.byteLength === 0) {
					writeJson(res, 200, {
						ok: false,
						code: "file-too-large",
						message: `文件为空或超过 ${Math.round(MAX_CANVAS_FILE_BYTES / (1024 * 1024))}MB 上限`
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						asset: await canvas.putFile({
							data,
							mime,
							name,
							origin: "upload"
						})
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "canvas-file-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_API.filePreview,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const assetId = typeof body?.assetId === "string" ? body.assetId : "";
				if (assetId === "") {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "assetId 是必填项"
					});
					return;
				}
				const found = await canvas.readAsset(assetId);
				if (found === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "not-found",
						message: "画布资产不存在，可能已被清理。"
					});
					return;
				}
				try {
					const hintName = typeof body?.name === "string" ? safeFileName(body.name) : "";
					const rawMime = typeof body?.mime === "string" && body.mime.length <= 160 ? baseMime$1(body.mime) : "";
					const mime = rawMime === "" || rawMime === "application/octet-stream" ? found.mime : rawMime;
					writeJson(res, 200, {
						ok: true,
						preview: buildFilePreview({
							data: found.data,
							mime,
							name: hintName === "" ? assetId : hintName,
							url: `${CANVAS_API.asset}/${encodeURIComponent(assetId)}?inline=1`
						})
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "preview-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (deps.skills === void 0) {
					writeJson(res, 200, {
						ok: true,
						skills: [],
						agentAvailable: false,
						registryAvailable: false,
						reason: "本宿主未挂载技能注册表（ctx.skills），画布技能不可用。"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						...await deps.skills.list(parseSkillLanguage(body).language)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "skills-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.run,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const request = parseSkillRunRequest(await readJsonBody(req));
				if (request === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "canvasId、skillId 与 nodeIds 是必填项"
					});
					return;
				}
				if (deps.skills === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "skills-unavailable",
						message: "本宿主未挂载技能运行时，画布技能不可用。"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						task: await deps.skills.run(request)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "skill-run-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.task,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (deps.skills === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "not-found",
						message: "任务不存在"
					});
					return;
				}
				const canvasId = typeof body?.canvasId === "string" ? body.canvasId.trim() : "";
				if (canvasId !== "") {
					writeJson(res, 200, {
						ok: true,
						tasks: deps.skills.tasksOfCanvas(canvasId)
					});
					return;
				}
				const id = typeof body?.taskId === "string" ? body.taskId.trim() : "";
				if (id === "") {
					writeJson(res, 200, {
						ok: false,
						code: "not-found",
						message: "任务不存在"
					});
					return;
				}
				const task = deps.skills.task(id);
				if (task === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "not-found",
						message: "任务不存在"
					});
					return;
				}
				writeJson(res, 200, {
					ok: true,
					task
				});
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.cancel,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const id = typeof body?.taskId === "string" ? body.taskId.trim() : "";
				if (id === "" || deps.skills === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "not-found",
						message: "任务不存在"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						cancelled: await deps.skills.cancel(id)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "skill-cancel-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.library,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (deps.skillLibrary === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "library-unavailable",
						message: "本宿主不支持管理本机技能库。"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						library: await deps.skillLibrary.list(parseSkillLanguage(body))
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "library-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.install,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (deps.skillLibrary === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "library-unavailable",
						message: "本宿主不支持安装技能。"
					});
					return;
				}
				const request = parseSkillInstallRequest(body);
				if (request === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "请提供技能来源链接或上传压缩包。"
					});
					return;
				}
				try {
					writeJson(res, 200, await deps.skillLibrary.install(request));
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "install-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.remove,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (deps.skillLibrary === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "library-unavailable",
						message: "本宿主不支持卸载技能。"
					});
					return;
				}
				const name = typeof body?.name === "string" ? body.name.trim() : "";
				if (name === "") {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "缺少技能名。"
					});
					return;
				}
				try {
					writeJson(res, 200, await deps.skillLibrary.remove(name, parseSkillLanguage(body)));
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "remove-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.configSave,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (deps.skillLibrary?.configSave === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "library-unavailable",
						message: "本宿主不支持保存技能配置。"
					});
					return;
				}
				const name = typeof body?.name === "string" ? body.name.trim() : "";
				if (name === "") {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "缺少技能名。"
					});
					return;
				}
				const values = (Array.isArray(body?.values) ? body.values : []).map((item) => {
					if (item === null || typeof item !== "object") return void 0;
					const record = item;
					const id = typeof record.id === "string" ? record.id.trim() : "";
					if (id === "" || typeof record.value !== "string") return void 0;
					return {
						id,
						value: record.value
					};
				}).filter((item) => item !== void 0).slice(0, 64);
				try {
					writeJson(res, 200, await deps.skillLibrary.configSave({
						name,
						values,
						...parseSkillLanguage(body)
					}));
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "config-save-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: CANVAS_SKILL_API.configApply,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				if (deps.skillLibrary?.configApply === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "library-unavailable",
						message: "本宿主不支持应用技能配置。"
					});
					return;
				}
				const name = typeof body?.name === "string" ? body.name.trim() : "";
				if (name === "") {
					writeJson(res, 200, {
						ok: false,
						code: "bad-request",
						message: "缺少技能名。"
					});
					return;
				}
				try {
					writeJson(res, 200, await deps.skillLibrary.configApply({
						name,
						...parseSkillLanguage(body)
					}));
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "config-apply-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: TEMPLATES_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const sourceId = templateSourceOf(body);
				if (sourceId === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "templates-source-unknown",
						message: `未知的模板库来源：${String(body?.source ?? "")}`
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						...await templates.list(sourceId)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "templates-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: TEMPLATES_API.refresh,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const sourceId = templateSourceOf(body);
				if (sourceId === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "templates-source-unknown",
						message: `未知的模板库来源：${String(body?.source ?? "")}`
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						...await templates.refresh(sourceId)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "templates-refresh-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: TEMPLATES_API.sample,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const requested = Number(body?.count);
				const count = Number.isFinite(requested) ? requested : 9;
				try {
					writeJson(res, 200, {
						ok: true,
						samples: await templates.sample(count)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "templates-sample-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "prefix",
			path: TEMPLATES_API.image,
			handler: async (req, res) => {
				if (!isLoopbackRequest(req)) {
					writeJson(res, 403, { error: "forbidden: loopback-only" });
					return;
				}
				if (req.method !== "GET") {
					writeJson(res, 405, { error: `method not allowed: ${req.method}` });
					return;
				}
				const raw = imageFileFrom(req.url, TEMPLATES_API.image);
				const slash = raw?.indexOf("/") ?? -1;
				const sourceId = slash > 0 ? raw.slice(0, slash) : "";
				const file = slash > 0 ? raw.slice(slash + 1) : "";
				if (sourceId === "" || !isTemplateSourceId(sourceId) || file === "") {
					writeJson(res, 404, { error: "not found" });
					return;
				}
				const found = await templates.readImage(sourceId, file);
				if (found === void 0) {
					writeJson(res, 404, { error: "not found" });
					return;
				}
				res.writeHead(200, {
					"content-type": found.mime,
					"content-length": found.data.length,
					"cache-control": "private, max-age=86400"
				});
				res.end(found.data);
			}
		},
		{
			kind: "exact",
			path: TEMPLATE_FAVORITES_API.list,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				try {
					writeJson(res, 200, {
						ok: true,
						favorites: await favorites.list()
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "template-favorites-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: TEMPLATE_FAVORITES_API.add,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const sourceId = templateSourceOf(body);
				const rawCase = body?.case;
				if (sourceId === void 0 || rawCase === null || typeof rawCase !== "object") {
					writeJson(res, 200, {
						ok: false,
						code: "template-favorite-invalid",
						message: "收藏请求缺少有效的来源或模板数据"
					});
					return;
				}
				const record = rawCase;
				const id = typeof record.id === "number" && Number.isFinite(record.id) ? String(record.id) : typeof record.id === "string" ? record.id.trim() : "";
				const title = typeof record.title === "string" ? record.title.trim() : "";
				const prompt = typeof record.prompt === "string" ? record.prompt.trim() : "";
				if (id === "" || title === "" || prompt === "") {
					writeJson(res, 200, {
						ok: false,
						code: "template-favorite-invalid",
						message: "收藏请求缺少有效的模板数据"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						favorites: await favorites.add(sourceId, rawCase)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "template-favorites-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: TEMPLATE_FAVORITES_API.remove,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const key = typeof body?.key === "string" ? body.key : "";
				if (key === "") {
					writeJson(res, 200, {
						ok: false,
						code: "template-favorite-invalid",
						message: "取消收藏请求缺少模板标识"
					});
					return;
				}
				try {
					writeJson(res, 200, {
						ok: true,
						favorites: await favorites.remove(key)
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "template-favorites-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: DATA_FOLDER_API,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const body = await readJsonBody(req);
				const dir = path.join(homedir(), ".dsh", "dsh-imagegen");
				try {
					await mkdir(dir, { recursive: true });
				} catch {}
				if (body?.open === false) {
					writeJson(res, 200, {
						ok: true,
						path: dir
					});
					return;
				}
				try {
					spawn(process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "open" : "xdg-open", [dir], {
						detached: true,
						stdio: "ignore"
					}).unref();
					writeJson(res, 200, {
						ok: true,
						path: dir
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "data-folder-failed",
						message: messageOf$2(error)
					});
				}
			}
		},
		{
			kind: "exact",
			path: STORAGE_API.test,
			handler: async (req, res) => {
				if (!guard(req, res, "POST")) return;
				const storage = deps.resolveStorage?.();
				if (storage === void 0) {
					writeJson(res, 200, {
						ok: false,
						code: "storage-unavailable",
						message: "存储配置不可用"
					});
					return;
				}
				try {
					const result = await testStorage(storage);
					writeJson(res, 200, {
						ok: true,
						ms: result.ms,
						key: result.key
					});
				} catch (error) {
					writeJson(res, 200, {
						ok: false,
						code: "storage-test-failed",
						message: messageOf$2(error)
					});
				}
			}
		}
	];
}
//#endregion
//#region src/agent-image-tools.ts
const imageRefSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		attachment_id: {
			type: "string",
			required: true
		},
		media_type: {
			type: "string",
			required: true
		},
		bytes: {
			type: "integer",
			required: true
		},
		width: {
			type: "integer",
			required: true
		},
		height: {
			type: "integer",
			required: true
		},
		name: { type: "string" }
	}
};
const taskResultSchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		task_id: {
			type: "string",
			required: true
		},
		status: {
			type: "string",
			required: true
		},
		message: {
			type: "string",
			required: true
		},
		error: { type: "string" },
		images: {
			type: "array",
			required: true,
			items: imageRefSchema
		}
	}
};
/** Agent calls stay pending until the provider and history write settle. */
const AGENT_GENERATION_TIMEOUT_MS = 3e5;
function ensureAgentImageConfigured(config) {
	if (!config.enabled) throw new ImageGenError("AI image generation is disabled. Open Settings → Image settings and enable it.", "plugin-disabled");
	if (!config.allowAgentImageGeneration) throw new ImageGenError("Agent image generation is disabled in Settings → Image settings.", "agent-generation-disabled");
	if (!config.channels.some((channel) => channel.apiUrl.trim() !== "" && channel.apiKey.trim() !== "")) throw new ImageGenError("Image API credentials are not configured. Open Settings → Image settings, add a channel and fill in its API URL and API key.", "image-api-not-configured");
}
/** Resolve a configured image alias and its owning channel. */
function resolveAgentImageModel(config, requested) {
	const entries = config.channels.flatMap((channel) => channel.models.map((model) => ({
		channel,
		alias: model.alias,
		upstream: model.id
	})));
	if (entries.length === 0) throw new ImageGenError("No image models are configured. Open Settings → Image settings and add a channel with at least one model.", "no-models-configured");
	const wanted = typeof requested === "string" && requested.trim() !== "" ? requested.trim() : typeof config.defaultModel === "string" ? config.defaultModel.trim() : "";
	if (wanted === "") {
		if (entries.length === 1) return entries[0];
		throw new ImageGenError(`Multiple image models are available — ask the user which channel and model to use, then call this tool again with that exact model name. Options: ${config.channels.flatMap((channel) => channel.models.map((model) => `"${channel.name} · ${model.alias}"`)).join(", ")}.`, "model-choice-required");
	}
	const hosting = entries.filter((entry) => entry.alias === wanted);
	if (hosting.length === 0) throw new ImageGenError(`Image model "${wanted}" is not configured in any channel. Choose one of: ${[...new Set(entries.map((entry) => entry.alias))].join(", ")}.`, "image-model-not-configured");
	return hosting.find((entry) => entry.channel.id === config.defaultChannelId) ?? hosting[0];
}
function findAgentImageTask(runtime, id) {
	const task = runtime.queue.list().find((candidate) => candidate.id === id);
	if (task === void 0) throw new ImageGenError(`Image generation task ${id} was not found.`, "task-not-found");
	return task;
}
/** Wait for a queue task without sending anything through the chat model. */
function waitForAgentImageTask(runtime, id, signal) {
	return new Promise((resolveTask, rejectTask) => {
		let settled = false;
		let dispose = () => {};
		let timer;
		let abort = () => {};
		const cleanup = () => {
			dispose();
			if (timer !== void 0) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		};
		const resolve = (task) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolveTask(task);
		};
		const reject = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			rejectTask(error);
		};
		abort = () => {
			if (settled) return;
			const reason = signal?.reason instanceof Error ? signal.reason : /* @__PURE__ */ new Error("Image generation was cancelled.");
			settled = true;
			cleanup();
			runtime.queue.cancel(id);
			rejectTask(reason);
		};
		const onChange = (updated) => {
			if (updated.id === id && isFinalTask(updated)) resolve(updated);
		};
		if (signal?.aborted === true) {
			abort();
			return;
		}
		dispose = runtime.queue.subscribe(onChange);
		signal?.addEventListener("abort", abort, { once: true });
		timer = setTimeout(() => {
			if (settled) return;
			const timeout = new ImageGenError(`Image generation task ${id} timed out after ${AGENT_GENERATION_TIMEOUT_MS / 1e3} seconds.`, "generation-timeout");
			settled = true;
			cleanup();
			runtime.queue.cancel(id);
			rejectTask(timeout);
		}, AGENT_GENERATION_TIMEOUT_MS);
		let current;
		try {
			current = findAgentImageTask(runtime, id);
		} catch (error) {
			reject(error);
			return;
		}
		if (isFinalTask(current)) resolve(current);
	});
}
/** Submit the same image-edit request used by the Agent tool. */
async function submitAgentImageEdit(attachments, runtime, resolve, input) {
	const config = resolve();
	ensureAgentImageConfigured(config);
	const reference = await attachments.readImage(input.sourceImage, input.signal);
	const fallbackModel = (config.channels.find((channel) => channel.id === config.defaultChannelId) ?? config.channels[0])?.models[0]?.alias ?? config.channels.flatMap((channel) => channel.models)[0]?.alias ?? "";
	const picked = resolveAgentImageModel(config, config.defaultModel?.trim() || fallbackModel);
	return waitForAgentImageTask(runtime, runtime.queue.submit({
		mode: "edit",
		model: picked.alias,
		upstream: picked.upstream,
		channelId: picked.channel.id,
		channel: picked.channel.name,
		prompt: input.prompt.trim(),
		size: "auto",
		quality: "auto",
		n: 1,
		detail: "",
		image: imageDataUrl(reference),
		...reference.ref.name === void 0 ? {} : { refName: reference.ref.name }
	}).id, input.signal);
}
function acceptedMediaType(value) {
	return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}
function projectRef(ref) {
	return {
		attachment_id: String(ref.attachmentId),
		media_type: ref.mediaType,
		bytes: ref.bytes,
		width: ref.width,
		height: ref.height,
		...ref.name === void 0 ? {} : { name: ref.name }
	};
}
function restoreRef(value) {
	if (!acceptedMediaType(value.media_type)) throw new ImageGenError("source_image.media_type is not a supported image type", "bad-reference-image");
	if (!Number.isInteger(value.bytes) || value.bytes < 1 || !Number.isInteger(value.width) || value.width < 1 || !Number.isInteger(value.height) || value.height < 1) throw new ImageGenError("source_image metadata is invalid", "bad-reference-image");
	return {
		attachmentId: value.attachment_id,
		mediaType: value.media_type,
		bytes: value.bytes,
		width: value.width,
		height: value.height,
		...value.name === void 0 ? {} : { name: value.name }
	};
}
function imageDataUrl(image) {
	return `data:${image.ref.mediaType};base64,${Buffer.from(image.data).toString("base64")}`;
}
function renderTaskResult(value) {
	return [{
		type: "text",
		text: JSON.stringify(value)
	}];
}
/** The UI-only projection that keeps generated images beside the tool call. */
function imagePresentationMeta(value) {
	return { images: value.images.map((image) => {
		const ref = {
			attachment_id: image.attachment_id,
			media_type: image.media_type,
			bytes: image.bytes,
			width: image.width,
			height: image.height
		};
		if (image.name !== void 0) ref.name = image.name;
		return ref;
	}) };
}
function imageBlocksFromMeta(meta) {
	if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return [];
	const images = meta.images;
	if (!Array.isArray(images)) return [];
	return images.flatMap((value) => {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
		const raw = value;
		if (typeof raw.attachment_id !== "string" || typeof raw.media_type !== "string" || typeof raw.bytes !== "number" || typeof raw.width !== "number" || typeof raw.height !== "number") return [];
		try {
			return [{
				type: "image",
				attachment: restoreRef({
					attachment_id: raw.attachment_id,
					media_type: raw.media_type,
					bytes: raw.bytes,
					width: raw.width,
					height: raw.height,
					...typeof raw.name === "string" ? { name: raw.name } : {}
				})
			}];
		} catch {
			return [];
		}
	});
}
/** Rehydrate image attachments for the host-computed tool result view only. */
function presentImageResult(_args, result) {
	const content = result.isError ? [] : imageBlocksFromMeta(result.meta);
	return content.length === 0 ? void 0 : {
		card: "generic",
		content
	};
}
/** Register the global Agent tools and unregister them with the plugin lifecycle. */
function registerAgentImageTools(ctx, runtime, resolve) {
	const attachmentRefs = /* @__PURE__ */ new Map();
	const ensureConfigured = () => {
		ensureAgentImageConfigured(resolve());
	};
	const resolveModel = (requested) => resolveAgentImageModel(resolve(), requested);
	const materializeTaskImages = (task) => {
		if (task.status !== "completed") return Promise.resolve([]);
		const existing = attachmentRefs.get(task.id);
		if (existing !== void 0) return existing;
		const pending = ctx.attachments.saveImages((task.result?.images ?? []).map((image, index) => toSaveImage(image, task.id, index))).then((refs) => refs.map(projectRef));
		attachmentRefs.set(task.id, pending);
		pending.catch(() => {
			if (attachmentRefs.get(task.id) === pending) attachmentRefs.delete(task.id);
		});
		return pending;
	};
	const taskResult = async (task) => {
		const images = await materializeTaskImages(task);
		return {
			task_id: task.id,
			status: task.status,
			message: task.status === "completed" ? "Generation completed. The images are shown beside this tool call and can be reused as source_image in edit_image." : task.status === "failed" ? "Generation failed." : task.status === "cancelled" ? "Generation was cancelled." : "Generation is still running. Query the task again when you need its current status.",
			...task.error === void 0 ? {} : { error: task.error },
			images
		};
	};
	const findTask = (id) => findAgentImageTask(runtime, id);
	const waitForTask = (id, signal) => waitForAgentImageTask(runtime, id, signal);
	const disposers = [
		ctx.tools.register(defineTool({
			name: "generate_image",
			description: "Generate an image. By default this tool call stays pending until the task reaches a final state; completed images are shown beside this tool call, while the model receives their attachment references, without creating a user message. Set wait_for_completion to false for background mode, then use get_image_generation_task explicitly. Only use models configured for this plugin; omit model to use the configured default image model (or the first model when none is configured).",
			parameters: {
				prompt: {
					type: "string",
					required: true,
					description: "Detailed image-generation prompt."
				},
				model: {
					type: "string",
					description: "One of the configured image models. Defaults to the configured default image model, or the first model when none is configured."
				},
				size: {
					type: "string",
					description: "Aspect ratio such as 1:1, 16:9, 9:16, or auto."
				},
				quality: {
					type: "string",
					description: "auto, 1k, 2k, or 4k."
				},
				count: {
					type: "integer",
					description: "Number of images, 1 to 4. Defaults to 1."
				},
				detail: {
					type: "string",
					description: "Optional provider detail value, for example standard or high."
				},
				wait_for_completion: {
					type: "boolean",
					description: "Wait for images and return them in this tool result. Defaults to true; set false for background mode."
				}
			},
			output: {
				schema: taskResultSchema,
				render: (_args, value) => renderTaskResult(value),
				presentationMeta: (_args, value) => imagePresentationMeta(value)
			},
			presentResult: presentImageResult,
			async execute(args, exec) {
				ensureConfigured();
				const picked = resolveModel(args.model);
				const task = runtime.queue.submit({
					mode: "text",
					model: picked.alias,
					upstream: picked.upstream,
					channelId: picked.channel.id,
					channel: picked.channel.name,
					prompt: args.prompt.trim(),
					size: args.size ?? "auto",
					quality: args.quality ?? "auto",
					n: Math.min(4, Math.max(1, args.count ?? 1)),
					detail: args.detail ?? ""
				});
				return taskResult(args.wait_for_completion === false ? task : await waitForTask(task.id, exec.signal));
			}
		})),
		ctx.tools.register(defineTool({
			name: "edit_image",
			description: "Edit an image. By default this tool call stays pending until the task reaches a final state; completed images are shown beside this tool call, while the model receives their attachment references, without creating a user message. Set wait_for_completion to false for background mode, then use get_image_generation_task explicitly. source_image must be an image reference returned by a completed generation or get_image_generation_task; pass that entire object unchanged. Only configured image models are allowed; omit model to use the configured default image model (or the first model when none is configured).",
			parameters: {
				prompt: {
					type: "string",
					required: true,
					description: "How to transform the source image."
				},
				source_image: {
					...imageRefSchema,
					required: true,
					description: "Image reference returned by get_image_generation_task."
				},
				model: {
					type: "string",
					description: "One of the configured image models. Defaults to the configured default image model, or the first model when none is configured."
				},
				size: {
					type: "string",
					description: "Aspect ratio such as 1:1, 16:9, 9:16, or auto."
				},
				quality: {
					type: "string",
					description: "auto, 1k, 2k, or 4k."
				},
				count: {
					type: "integer",
					description: "Number of images, 1 to 4. Defaults to 1."
				},
				detail: {
					type: "string",
					description: "Optional provider detail value."
				},
				wait_for_completion: {
					type: "boolean",
					description: "Wait for images and return them in this tool result. Defaults to true; set false for background mode."
				}
			},
			output: {
				schema: taskResultSchema,
				render: (_args, value) => renderTaskResult(value),
				presentationMeta: (_args, value) => imagePresentationMeta(value)
			},
			presentResult: presentImageResult,
			async execute(args, exec) {
				ensureConfigured();
				const reference = await ctx.attachments.readImage(restoreRef(args.source_image), exec.signal);
				const picked = resolveModel(args.model);
				const task = runtime.queue.submit({
					mode: "edit",
					model: picked.alias,
					upstream: picked.upstream,
					channelId: picked.channel.id,
					channel: picked.channel.name,
					prompt: args.prompt.trim(),
					size: args.size ?? "auto",
					quality: args.quality ?? "auto",
					n: Math.min(4, Math.max(1, args.count ?? 1)),
					detail: args.detail ?? "",
					image: imageDataUrl(reference),
					...reference.ref.name === void 0 ? {} : { refName: reference.ref.name }
				});
				return taskResult(args.wait_for_completion === false ? task : await waitForTask(task.id, exec.signal));
			}
		})),
		ctx.tools.register(defineTool({
			name: "get_image_generation_task",
			description: "Check an image-generation task status. Completed tasks return image references; their images are shown beside this tool call and the references can be passed to edit_image. Generation tools normally wait for completion, so use this for explicit recovery or status checks.",
			parameters: { task_id: {
				type: "string",
				required: true,
				description: "Task id returned by generate_image or edit_image."
			} },
			output: {
				schema: taskResultSchema,
				render: (_args, value) => renderTaskResult(value),
				presentationMeta: (_args, value) => imagePresentationMeta(value)
			},
			presentResult: presentImageResult,
			async execute(args) {
				ensureConfigured();
				return taskResult(findTask(args.task_id));
			}
		})),
		ctx.tools.register(defineTool({
			name: "cancel_image_generation_task",
			description: "Cancel a queued or running image generation task.",
			parameters: { task_id: {
				type: "string",
				required: true,
				description: "Task id returned by generate_image or edit_image."
			} },
			output: {
				schema: taskResultSchema,
				render: (_args, value) => renderTaskResult(value),
				presentationMeta: (_args, value) => imagePresentationMeta(value)
			},
			presentResult: presentImageResult,
			async execute(args) {
				ensureConfigured();
				const task = runtime.queue.cancel(args.task_id);
				if (task === void 0) throw new ImageGenError(`Image generation task ${args.task_id} was not found.`, "task-not-found");
				return taskResult(task);
			}
		}))
	];
	return () => {
		for (const dispose of disposers) dispose();
	};
}
function isFinalTask(task) {
	return task.status === "completed" || task.status === "failed" || task.status === "cancelled";
}
function toSaveImage(image, taskId, index) {
	const data = Buffer.from(image.b64, "base64");
	const declaredMediaType = acceptedMediaType(image.mime) ? image.mime : "image/png";
	const mediaType = detectImageMime(data) ?? declaredMediaType;
	return {
		data,
		mediaType,
		name: `imagegen-${taskId}-${index + 1}.${mediaType === "image/jpeg" ? "jpg" : mediaType.slice(6)}`
	};
}
//#endregion
//#region src/edit-image-command.ts
function isImageReference(value) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const ref = value;
	return typeof ref.attachmentId === "string" && (ref.mediaType === "image/png" || ref.mediaType === "image/jpeg" || ref.mediaType === "image/webp" || ref.mediaType === "image/gif") && Number.isInteger(ref.bytes) && ref.bytes > 0 && Number.isInteger(ref.width) && ref.width > 0 && Number.isInteger(ref.height) && ref.height > 0;
}
function imageInContent(value) {
	if (!Array.isArray(value)) return void 0;
	for (let index = value.length - 1; index >= 0; index -= 1) {
		const block = value[index];
		if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
		const raw = block;
		if (raw.type === "image" && isImageReference(raw.attachment)) return raw.attachment;
		if (raw.type === "tool-result") {
			const nested = imageInContent(raw.content);
			if (nested !== void 0) return nested;
		}
	}
}
/** Pick the newest image explicitly attached to this command invocation. */
function imageInInvocation(value) {
	if (!Array.isArray(value)) return void 0;
	for (let index = value.length - 1; index >= 0; index -= 1) {
		const block = value[index];
		if (typeof block !== "object" || block === null || Array.isArray(block)) continue;
		const raw = block;
		if (raw.type === "image" && isImageReference(raw.attachment)) return raw.attachment;
	}
}
/** Find the newest durable image reference, including nested tool results. */
function latestSessionImage(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (typeof message !== "object" || message === null || Array.isArray(message)) continue;
		const image = imageInContent(message.content);
		if (image !== void 0) return image;
	}
}
function commandError(error) {
	const text = error instanceof Error ? error.message : String(error);
	return {
		kind: "error",
		text: text.trim() === "" ? "图片编辑失败。" : text
	};
}
/** Register the host-side command; it never sends the command line to a chat model. */
function registerEditImageCommand(ctx, runtime, resolve, pendingImages) {
	return ctx.commands.register({
		name: "edit_image",
		description: "Edit the latest image in this conversation with the plugin image model",
		input: {
			hint: "Describe how to modify the latest image",
			images: true
		},
		async handler(invocation) {
			const prompt = invocation.rawInput.trim();
			if (prompt === "") return {
				kind: "error",
				text: "请提供图片修改描述，例如：/edit_image 把背景改成夜景"
			};
			const invocationImage = imageInInvocation(invocation.attachments);
			const pendingImage = pendingImages?.get(String(invocation.agent.id));
			const durableImage = latestSessionImage(invocation.agent.session.deriveMessages());
			const sourceImage = invocationImage ?? pendingImage ?? durableImage;
			if (sourceImage === void 0) return {
				kind: "error",
				text: "当前对话没有可用图片，请先上传图片或把画廊图片加入对话。"
			};
			try {
				const task = await submitAgentImageEdit(ctx.attachments, runtime, resolve, {
					prompt,
					sourceImage,
					signal: invocation.signal
				});
				if (task.status === "completed") {
					if (pendingImage !== void 0) pendingImages?.consume(String(invocation.agent.id), pendingImage);
					return {
						kind: "success",
						text: "图片编辑已完成，可在 AI 生图面板查看结果。"
					};
				}
				return {
					kind: "error",
					text: task.error ?? `图片编辑${task.status === "cancelled" ? "已取消" : "失败"}。`
				};
			} catch (error) {
				return commandError(error);
			}
		}
	});
}
//#endregion
//#region src/skills-catalog.ts
/** The external-skill name of the deck-rebuilding pipeline this plugin knows
*  how to drive end to end (image → editable .pptx). */
const EDITABLE_PPT_SKILL = "image-to-editable-ppt";
/** Origin label used for built-in catalog entries. */
const BUILTIN_ORIGIN = "builtin";
/** Style presets offered by the text polish action. */
const POLISH_STYLES = [
	"formal",
	"casual",
	"shorter",
	"expand",
	"custom"
];
/** Copy keys of the polish style labels (kept literal so the copy table can
*  typecheck them; a computed template literal would widen to `string`). The
*  catalog reuses the canvas button labels so one style reads the same in the
*  picker and on the text node toolbar. */
const POLISH_STYLE_KEYS = {
	formal: "canvas.polish.formal",
	casual: "canvas.polish.casual",
	shorter: "canvas.polish.shorter",
	expand: "canvas.polish.expand",
	custom: "canvas.polish.custom"
};
/** Built-in ids (stable: they are persisted on produced nodes as provenance). */
const BUILTIN_POLISH = "polish.text";
const BUILTIN_DESCRIBE = "describe.image";
const BUILTIN_EXTRACT = "extract.content";
const BUILTIN_PPT = "ppt.fromImages";
/**
* The built-in catalog. Order is the menu order: the high-frequency text
* actions first, the long-running deck conversion last.
* @param t - copy resolver for the current UI language.
* @param options - whether the host agent runtime answered; a heavy entry
*   without one stays visible but marked unavailable. `pptInstallUrl` is the
*   upstream home of the deck pipeline, offered as a one-click install.
*/
function builtinCanvasSkills(t, options) {
	const polishStyles = POLISH_STYLES.map((style) => ({
		id: style,
		label: t(POLISH_STYLE_KEYS[style])
	}));
	return [
		{
			id: BUILTIN_POLISH,
			name: t("canvas.skills.polish"),
			description: t("canvas.skills.polishDesc"),
			origin: BUILTIN_ORIGIN,
			tier: "light",
			accepts: ["text"],
			output: "text",
			params: polishStyles
		},
		{
			id: BUILTIN_DESCRIBE,
			name: t("canvas.skills.describe"),
			description: t("canvas.skills.describeDesc"),
			origin: BUILTIN_ORIGIN,
			tier: "light",
			accepts: ["image"],
			output: "text"
		},
		{
			id: BUILTIN_EXTRACT,
			name: t("canvas.skills.extract"),
			description: t("canvas.skills.extractDesc"),
			origin: BUILTIN_ORIGIN,
			tier: "light",
			accepts: ["file", "image"],
			output: "text"
		},
		{
			id: BUILTIN_PPT,
			name: t("canvas.skills.ppt"),
			description: t("canvas.skills.pptDesc"),
			origin: BUILTIN_ORIGIN,
			tier: "heavy",
			accepts: ["image"],
			output: "file",
			costHint: t("canvas.skills.pptCost"),
			requires: options.agentAvailable ? [t("canvas.skills.pptRequires")] : [t("canvas.skills.needAgent")],
			skillName: EDITABLE_PPT_SKILL,
			...options.pptInstallUrl === void 0 ? {} : { installUrl: options.pptInstallUrl }
		}
	];
}
/** Long-running pipeline markers: a skill matching one of these runs an agent. */
const HEAVY_SKILL_HINTS = [
	"ppt",
	"pptx",
	"slide",
	"deck",
	"keynote",
	"presentation",
	"pdf",
	"word",
	"docx",
	"excel",
	"xlsx",
	"video",
	"render",
	"export",
	"batch",
	"pipeline",
	"ocr"
];
/** Declared tier in skill frontmatter, when a skill author set one. */
function declaredTier(metadata) {
	if (metadata === void 0) return void 0;
	for (const key of [
		"tier",
		"canvasTier",
		"executionTier",
		"runtime"
	]) {
		const value = metadata[key];
		if (value === "heavy" || value === "light") return value;
	}
}
/**
* Decide whether an external skill needs the headless-agent tier. Explicit
* frontmatter wins; otherwise the name/description is matched against the
* long-running pipeline vocabulary. Unknown skills default to `light`, which is
* the cheaper and more predictable failure mode (a light run that is too small
* reports an actionable error instead of silently burning an agent run).
*/
function tierOfExternalSkill(skill) {
	const declared = declaredTier(skill.metadata);
	if (declared !== void 0) return declared;
	const haystack = `${skill.name} ${skill.description} ${skill.whenToUse ?? ""}`.toLowerCase();
	return HEAVY_SKILL_HINTS.some((hint) => haystack.includes(hint)) ? "heavy" : "light";
}
/** Whether one external skill is the deck pipeline this plugin drives itself. */
function isEditablePptSkill(name) {
	return name === "image-to-editable-ppt" || name.includes("image-to-editable") || name.includes("editable-ppt");
}
/**
* Merge the host registry's summaries into the canvas catalog. Only
* model-invocable skills are offered: the canvas runs skills through a model,
* so a user-only (slash-command) skill would fail halfway.
* @param skills - host registry summaries.
* @param t - copy resolver for the current UI language.
* @param options - run-layer availability, used for the heavy entries' hints;
*   `configMissing` reports a skill's unset required configuration by name.
*/
function mergeExternalSkills(skills, t, options) {
	return skills.map((skill) => {
		const tier = tierOfExternalSkill(skill);
		const name = t("canvas.skills.externalName", { name: skill.name });
		const configMissing = options.configMissing?.(skill.name);
		return {
			id: `skill:${skill.name}`,
			name,
			description: skill.description.trim() === "" ? t("canvas.skills.noDescription") : skill.description,
			...skill.whenToUse === void 0 || skill.whenToUse.trim() === "" ? {} : { whenToUse: skill.whenToUse },
			origin: "external",
			tier,
			accepts: [
				"image",
				"text",
				"file"
			],
			output: "text",
			...tier === "heavy" ? {
				costHint: t("canvas.skills.externalHeavyCost", { name: skill.name }),
				requires: options.agentAvailable ? [] : [t("canvas.skills.needAgent")]
			} : {},
			...configMissing === void 0 || configMissing.length === 0 ? {} : { configMissing }
		};
	});
}
/** The whole catalog for one canvas: built-ins first, then host skills. */
function canvasSkillCatalog(external, t, options) {
	const builtins = builtinCanvasSkills(t, options);
	const taken = new Set(builtins.map((skill) => skill.id));
	const merged = mergeExternalSkills(external, t, options).filter((skill) => !taken.has(skill.id));
	return [...builtins, ...merged];
}
/** Resolve one catalog entry by id (built-ins are stable, externals prefixed). */
function findCanvasSkill(catalog, id) {
	return catalog.find((skill) => skill.id === id);
}
/** Cap on the text handed to the light tier from text nodes. */
const MAX_INLINE_TEXT = 4e4;
/** Cap on the images handed to one vision call. */
const MAX_VISION_IMAGES = 6;
/** Completed tasks are kept for the poll window, then evicted. */
const MAX_TRACKED_TASKS = 200;
/** Output node footprints (world units), matching the client's node sizes. */
const TEXT_NODE_SIZE = {
	width: 320,
	height: 260
};
const FILE_NODE_SIZE = {
	width: 300,
	height: 170
};
const NODE_GAP = 96;
/** Chat-model instructions per built-in light action. */
const POLISH_DIRECTIVES = {
	formal: {
		zh: "改写得更正式、专业、书面化，保留原意与信息量，不要添加新事实。",
		en: "Rewrite it in a more formal, professional register. Preserve meaning and facts; add nothing."
	},
	casual: {
		zh: "改写得更口语、轻松、自然，保留原意与信息量。",
		en: "Rewrite it in a casual, conversational, natural voice. Preserve meaning and facts."
	},
	shorter: {
		zh: "压缩到原文 60% 以内的篇幅，只保留关键信息，语句通顺。",
		en: "Compress it to at most 60% of the original length, keeping only the key information."
	},
	expand: {
		zh: "在保留原意的前提下扩写，补充必要的细节、例子或过渡，让内容更充实。",
		en: "Expand it with necessary detail, examples or transitions while preserving the original intent."
	}
};
const DESCRIBE_SYSTEM = "你是图像理解引擎。请用简洁、具体的语言描述这张图片：主体、场景、构图、光线、色彩风格、文字与关键元素。只输出描述正文，不要客套话，不要 markdown 标题。";
function describeSystem(language) {
	return language.startsWith("zh") || language === "" ? DESCRIBE_SYSTEM : "You are an image-understanding engine. Describe this image concretely: subject, scene, composition, lighting, color and style, text and key elements. Output the description only — no preface, no markdown headings.";
}
/** Deterministic id generator, injectable for tests. */
let idFactory = (prefix) => `${prefix}-${randomUUID()}`;
function newId(prefix) {
	return idFactory(prefix);
}
function messageOf$1(error) {
	return error instanceof Error ? error.message : String(error);
}
function baseMime(mime) {
	return mime.split(";")[0].trim().toLowerCase();
}
function isImageAsset(asset) {
	return asset.kind !== "file" && baseMime(asset.mime).startsWith("image/");
}
function nodeText(node) {
	return typeof node.metadata?.text === "string" ? node.metadata.text.trim() : "";
}
function nodeTitle(node) {
	return node.title.trim() === "" ? node.type : node.title.trim();
}
/** Union of explicit ids and every node connected into them. */
function resolveInputIds(document, request) {
	const explicit = request.nodeIds.filter((id) => id.trim() !== "");
	const targets = explicit.length > 0 ? explicit : [];
	const ids = new Set(targets);
	for (const connection of document.connections) if (targets.includes(connection.toNodeId)) ids.add(connection.fromNodeId);
	return [...ids];
}
function textOutputNode(source, title, text, skillId, label, sourceIds) {
	const metadata = source.metadata ?? {};
	return {
		id: newId("node"),
		type: "text",
		title,
		x: source.x + source.width + NODE_GAP,
		y: source.y,
		width: TEXT_NODE_SIZE.width,
		height: TEXT_NODE_SIZE.height,
		metadata: {
			text,
			fontSize: typeof metadata.fontSize === "number" ? metadata.fontSize : 14,
			status: "success",
			skill: {
				id: skillId,
				label,
				sourceNodeIds: sourceIds,
				createdAt: Date.now()
			}
		}
	};
}
function fileOutputNode(source, asset, title, skillId, label, sourceIds) {
	return {
		id: newId("node"),
		type: "file",
		title,
		x: source.x + source.width + NODE_GAP,
		y: source.y,
		width: FILE_NODE_SIZE.width,
		height: FILE_NODE_SIZE.height,
		metadata: {
			asset,
			fileKind: fileKindOf(asset.mime, asset.name ?? ""),
			status: "success",
			skill: {
				id: skillId,
				label,
				sourceNodeIds: sourceIds,
				createdAt: Date.now()
			}
		}
	};
}
/** Wrap produced nodes into the wire output (drafts only — no ids rewritten). */
function outputOf(nodes, connections, warnings = []) {
	return {
		nodes,
		connections,
		warnings
	};
}
/** Find the last assistant text in a session message list (structural). */
function lastAssistantText(messages) {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === null || typeof message !== "object") continue;
		const record = message;
		if (record.role !== "assistant" || !Array.isArray(record.content)) continue;
		const text = record.content.flatMap((block) => {
			if (block === null || typeof block !== "object") return [];
			const entry = block;
			return entry.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
		}).join("\n").trim();
		if (text !== "") return text;
	}
}
var SkillRunner = class {
	options;
	tasks = /* @__PURE__ */ new Map();
	cancellers = /* @__PURE__ */ new Map();
	tail = Promise.resolve();
	backend;
	constructor(options) {
		this.options = options;
		this.backend = { ...options.backend };
	}
	/**
	* Attach or replace the optional host seams (skill registry, agent runtime).
	* Called from the plugin's soft injection once those services exist, and with
	* an empty object when they unload. The chat and canvas seams are never
	* replaced here.
	* @param parts - the seams to adopt; omitted keys are cleared.
	*/
	attach(parts) {
		this.backend.registry = parts.registry;
		this.backend.agents = parts.agents;
		this.backend.skillConfig = parts.skillConfig;
	}
	/**
	* The catalog offered to the canvas (built-ins + allowlisted host skills).
	* @param language - UI language for the catalog copy (falls back to the
	*   installed resolver, then to the runner default).
	*/
	async list(language) {
		const t = this.translate(language);
		const registry = this.backend.registry;
		const agentAvailable = this.backend.agents?.available() === true && this.options.heavyEnabled();
		if (!this.options.enabled()) return {
			skills: [],
			agentAvailable,
			registryAvailable: registry !== void 0,
			installed: [],
			reason: t("canvas.skills.disabled")
		};
		let external = [];
		let registryAvailable = false;
		let reason;
		if (registry === void 0) reason = t("canvas.skills.noRegistry");
		else try {
			const listed = await registry.list();
			const allow = this.options.allowlist().map((item) => item.trim()).filter((item) => item !== "");
			external = allow.length === 0 ? listed : listed.filter((skill) => allow.includes(skill.name));
			registryAvailable = true;
		} catch (error) {
			reason = t("canvas.skills.registryFailed", { message: messageOf$1(error) });
		}
		const missing = this.backend.skillConfig === void 0 ? void 0 : await this.backend.skillConfig.missing(external.map((skill) => skill.name)).catch(() => void 0);
		return {
			skills: canvasSkillCatalog(external, t, {
				agentAvailable,
				...this.options.pptInstallUrl === void 0 ? {} : { pptInstallUrl: this.options.pptInstallUrl },
				...missing === void 0 ? {} : { configMissing: (name) => missing.get(name) }
			}),
			agentAvailable,
			registryAvailable,
			installed: external.map((skill) => skill.name),
			...reason === void 0 ? {} : { reason },
			...agentAvailable ? {} : { reason: reason ?? t("canvas.skills.needAgent") }
		};
	}
	/** Queue one run and return its task immediately (the client polls it). */
	async run(request) {
		const t = this.translate(request.language);
		const catalog = await this.list(request.language);
		const skill = catalog.skills.find((item) => item.id === request.skillId);
		if (skill === void 0) throw new Error(t("canvas.skills.unknown"));
		const document = await this.backend.canvas.read(request.canvasId);
		if (document === void 0) throw new Error(t("canvas.skills.canvasMissing"));
		const ids = resolveInputIds(document, request).slice(0, 12);
		const byId = new Map(document.nodes.map((node) => [node.id, node]));
		const inputs = ids.flatMap((id) => {
			const node = byId.get(id);
			if (node === void 0 || node.type === "config") return [];
			const asset = node.metadata?.asset;
			return [{
				node,
				...asset === void 0 ? {} : { asset }
			}];
		});
		if (inputs.length === 0) throw new Error(t("canvas.skills.noInput"));
		const target = inputs.find((input) => request.nodeIds.includes(input.node.id)) ?? inputs[0];
		if (!skill.accepts.includes(target.node.type)) throw new Error(t("canvas.skills.incompatible"));
		if (skill.tier === "heavy" && !catalog.agentAvailable) throw new Error(t("canvas.skills.needAgent"));
		const language = request.language;
		const task = {
			id: newId("skillrun"),
			canvasId: request.canvasId,
			skillId: skill.id,
			label: skill.name,
			tier: skill.tier,
			status: "queued",
			stage: this.translate(language)("canvas.skills.stageQueued"),
			phase: "queued",
			nodeIds: [...request.nodeIds],
			startedAt: Date.now(),
			...language === void 0 || language === "" ? {} : { language }
		};
		this.tasks.set(task.id, task);
		this.pruneTasks();
		this.enqueue(task, skill, inputs, request).catch((error) => {
			task.status = "failed";
			task.error = messageOf$1(error);
			task.finishedAt = Date.now();
		});
		return task;
	}
	/** One task snapshot, or undefined once evicted. */
	task(id) {
		return this.tasks.get(id);
	}
	/** Unfinished runs of one canvas, so a reopened canvas can rebuild its live
	*  run cards after a reload (the browser holds no run state itself). */
	tasksOfCanvas(canvasId) {
		return [...this.tasks.values()].filter((task) => task.canvasId === canvasId && (task.status === "queued" || task.status === "running"));
	}
	/** Cancel a queued or running task. */
	async cancel(id) {
		const task = this.tasks.get(id);
		if (task === void 0) return false;
		if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") return false;
		task.status = "cancelled";
		task.stage = this.translate(task.language)("canvas.skills.stageCancelled");
		task.finishedAt = Date.now();
		const canceller = this.cancellers.get(id);
		this.cancellers.delete(id);
		if (canceller !== void 0) await canceller.dispose().catch(() => {});
		return true;
	}
	enqueue(task, skill, inputs, request) {
		const cancelled = () => this.tasks.get(task.id)?.status === "cancelled";
		const run = async () => {
			if (cancelled()) return;
			task.status = "running";
			task.phase = "running";
			try {
				task.output = skill.tier === "heavy" ? await this.runHeavy(task, skill, inputs, request) : await this.runLight(task, skill, inputs, request);
				if (!cancelled()) {
					task.status = "completed";
					task.stage = this.translate(task.language)("canvas.skills.stageDone");
					task.phase = void 0;
				}
			} catch (error) {
				if (!cancelled()) {
					task.status = "failed";
					task.error = messageOf$1(error);
					task.phase = void 0;
				}
			} finally {
				task.finishedAt = Date.now();
				this.cancellers.delete(task.id);
			}
		};
		const next = this.tail.then(run, run);
		this.tail = next.then(() => void 0, () => void 0);
		return next;
	}
	pruneTasks() {
		if (this.tasks.size <= MAX_TRACKED_TASKS) return;
		const finished = [...this.tasks.values()].filter((task) => task.finishedAt !== void 0).sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));
		for (const task of finished.slice(0, this.tasks.size - MAX_TRACKED_TASKS)) this.tasks.delete(task.id);
	}
	async runLight(task, skill, inputs, request) {
		const t = this.translate(task.language);
		const chat = this.backend.chat;
		if (chat === void 0) throw new Error(t("canvas.skills.noChat"));
		task.stage = t("canvas.skills.stageReading");
		task.phase = "running";
		await this.loadAssets(inputs);
		const target = inputs.find((input) => request.nodeIds.includes(input.node.id)) ?? inputs[0];
		if (skill.id === "extract.content" && target.node.type === "file") return this.runBuiltinExtract(target, skill, t);
		if (skill.id === "extract.content") return this.runCollectedLight(target, inputs, skill, t);
		if (skill.id === "describe.image") return this.runBuiltinDescribe(target, inputs, skill, chat, t);
		if (skill.id === "polish.text") return this.runBuiltinPolish(target, skill, request, chat, t);
		return this.runExternalLight(target, inputs, skill, request, chat, t);
	}
	/** Read the asset bytes for every image/file input once. */
	async loadAssets(inputs) {
		const canvas = this.backend.canvas;
		const pending = inputs.filter((input) => input.asset !== void 0 && input.data === void 0);
		if (pending.length === 0) return;
		const refs = pending.map((input) => input.asset).filter((ref) => ref.assetId !== "");
		const found = await canvas.readAssets(refs);
		for (const input of pending) {
			const asset = input.asset;
			const hit = found.get(asset.assetId);
			if (hit !== void 0) input.data = hit.data;
		}
	}
	runBuiltinExtract(target, skill, t) {
		const asset = target.asset;
		if (asset === void 0 || target.data === void 0) throw new Error(t("canvas.skills.fileMissing"));
		const name = asset.name ?? asset.assetId;
		const extracted = extractFileText(target.data, name, asset.mime);
		const warnings = [...extracted.warning === void 0 ? [] : [extracted.warning], ...extracted.truncated ? [t("canvas.skills.truncated", { count: MAX_EXTRACTED_CHARS })] : []];
		if (!extracted.supported) throw new Error(extracted.warning ?? t("canvas.skills.extractFailed"));
		const sourceIds = [target.node.id];
		const node = textOutputNode(target.node, t("canvas.skills.extractNodeTitle", { name }), extracted.text, skill.id, skill.name, sourceIds);
		const connection = {
			id: newId("edge"),
			fromNodeId: target.node.id,
			toNodeId: node.id
		};
		return outputOf([node], [connection], warnings);
	}
	/** Collect text from every input and hand it to the model in one shot. Used
	*  when a built-in cannot decode the input itself (image extraction). */
	runCollectedLight(target, inputs, skill, t) {
		const subject = inputs.find((input) => input.node.id === target.node.id) ?? inputs[0];
		const pieces = [];
		const warnings = [];
		for (const input of inputs) {
			const text = nodeText(input.node);
			if (text !== "") {
				pieces.push(text);
				continue;
			}
			const asset = input.asset;
			if (asset === void 0 || input.data === void 0) continue;
			const extracted = extractFileText(input.data, asset.name ?? asset.assetId, asset.mime);
			if (extracted.supported && extracted.text !== "") pieces.push(extracted.text);
			else if (extracted.warning !== void 0) warnings.push(extracted.warning);
		}
		if (pieces.length === 0) throw new Error(t("canvas.skills.nothingToRead"));
		const joined = pieces.join("\n\n---\n\n");
		const text = `${t("canvas.skills.summaryHead", { count: pieces.length })}\n\n${joined.slice(0, MAX_EXTRACTED_CHARS)}`;
		const node = textOutputNode(subject.node, skill.name, text, skill.id, skill.name, [subject.node.id]);
		return outputOf([node], [{
			id: newId("edge"),
			fromNodeId: subject.node.id,
			toNodeId: node.id
		}], warnings);
	}
	async runBuiltinDescribe(target, inputs, skill, chat, t) {
		const images = inputs.filter((input) => input.node.type === "image" && input.asset !== void 0 && isImageAsset(input.asset));
		if (images.length === 0) throw new Error(t("canvas.skills.needImage"));
		const parts = [{
			type: "text",
			text: t("canvas.skills.describeAsk", { count: images.length })
		}];
		for (const input of images.slice(0, MAX_VISION_IMAGES)) {
			if (input.data === void 0) continue;
			parts.push({
				type: "image_url",
				image_url: { url: `data:${baseMime(input.asset.mime)};base64,${input.data.toString("base64")}` }
			});
		}
		const answer = await chat.complete({
			system: describeSystem(currentSkillLanguage()),
			content: parts,
			temperature: .3
		});
		const warnings = images.length > MAX_VISION_IMAGES ? [t("canvas.skills.tooManyImages", { count: MAX_VISION_IMAGES })] : [];
		const node = textOutputNode(target.node, skill.name, answer, skill.id, skill.name, [target.node.id]);
		return outputOf([node], [{
			id: newId("edge"),
			fromNodeId: target.node.id,
			toNodeId: node.id
		}], warnings);
	}
	async runBuiltinPolish(target, skill, request, chat, t) {
		const original = nodeText(target.node);
		if (original === "") throw new Error(t("canvas.skills.needText"));
		const style = (request.params?.style ?? "formal").trim();
		const language = currentSkillLanguage();
		const english = !(language.startsWith("zh") || language === "");
		const directive = style === "custom" ? (request.instruction ?? "").trim() : (POLISH_DIRECTIVES[style] ?? POLISH_DIRECTIVES.formal)[english ? "en" : "zh"];
		if (directive === "") throw new Error(t("canvas.skills.needInstruction"));
		const system = english ? "You are a text editor. Rewrite the user text following the instruction exactly. Preserve the original language and every fact. Return only the rewritten text — no preface, no quotes, no markdown fences." : "你是文字编辑。请严格按指令改写用户提供的文本，保持原语言与全部事实不变。只输出改写后的正文，不要任何说明、引号或 markdown 代码块。";
		const answer = await chat.complete({
			system,
			content: `${directive}\n\n---\n${original}`,
			temperature: .4
		});
		const node = textOutputNode(target.node, t("canvas.skills.polishNodeTitle", { style: t(`canvas.polish.${style}`) }), answer, skill.id, skill.name, [target.node.id]);
		return outputOf([node], [{
			id: newId("edge"),
			fromNodeId: target.node.id,
			toNodeId: node.id
		}]);
	}
	/** External skill through the light tier: skill body in, answer out. */
	async runExternalLight(target, inputs, skill, request, chat, t) {
		const registry = this.backend.registry;
		const name = skill.id.startsWith("skill:") ? skill.id.slice(6) : skill.id;
		const definition = registry === void 0 ? void 0 : await registry.get(name);
		const warnings = [];
		const sections = [];
		if (definition !== void 0 && definition.content.trim() !== "") sections.push(definition.content.trim());
		const configNote = await this.backend.skillConfig?.note(name).catch(() => void 0);
		if (configNote !== void 0 && configNote !== "") sections.push(`${t("canvas.skills.configHeader")}\n${configNote}`);
		for (const input of inputs) {
			const text = nodeText(input.node);
			if (text !== "") {
				sections.push(`### ${nodeTitle(input.node)}\n${text.slice(0, MAX_INLINE_TEXT)}`);
				continue;
			}
			const asset = input.asset;
			if (asset === void 0 || input.data === void 0) continue;
			const extracted = extractFileText(input.data, asset.name ?? asset.assetId, asset.mime);
			if (extracted.supported && extracted.text !== "") sections.push(`### ${asset.name ?? nodeTitle(input.node)}\n${extracted.text.slice(0, MAX_INLINE_TEXT)}`);
			else if (extracted.warning !== void 0) warnings.push(extracted.warning);
		}
		const parts = [{
			type: "text",
			text: this.externalUserPrompt(skill, sections, request, t)
		}];
		for (const input of inputs) {
			const asset = input.asset;
			if (asset === void 0 || input.data === void 0 || !isImageAsset(asset)) continue;
			if (parts.length > MAX_VISION_IMAGES) {
				warnings.push(t("canvas.skills.tooManyImages", { count: MAX_VISION_IMAGES }));
				break;
			}
			parts.push({
				type: "image_url",
				image_url: { url: `data:${baseMime(asset.mime)};base64,${input.data.toString("base64")}` }
			});
		}
		const answer = await chat.complete({
			system: t("canvas.skills.externalSystem", { name: skill.name }),
			content: parts,
			temperature: .35
		});
		const node = textOutputNode(target.node, skill.name, answer, skill.id, skill.name, [target.node.id]);
		return outputOf([node], [{
			id: newId("edge"),
			fromNodeId: target.node.id,
			toNodeId: node.id
		}], warnings);
	}
	externalUserPrompt(skill, sections, request, t) {
		const header = t("canvas.skills.externalHeader", { name: skill.name });
		const instruction = (request.instruction ?? "").trim();
		return [
			header,
			...instruction === "" ? [] : [
				"",
				t("canvas.skills.extraInstruction"),
				instruction
			],
			"",
			t("canvas.skills.inputsHeader"),
			...sections.length === 0 ? [t("canvas.skills.inputsEmpty")] : sections
		].join("\n");
	}
	async runHeavy(task, skill, inputs, request) {
		const t = this.translate(task.language);
		const agents = this.backend.agents;
		if (agents === void 0 || !agents.available()) throw new Error(t("canvas.skills.needAgent"));
		const canvas = this.backend.canvas;
		await canvas.read(request.canvasId);
		const target = inputs.find((input) => request.nodeIds.includes(input.node.id)) ?? inputs[0];
		const runRoot = this.options.runRoot().trim() === "" ? path.join(this.options.dataRoot(), "canvas", "runs") : this.options.runRoot().trim();
		const runDir = path.join(runRoot, request.canvasId, task.id);
		const inputDir = path.join(runDir, "input");
		const outputDir = path.join(runDir, "output");
		await promises.mkdir(inputDir, { recursive: true });
		await promises.mkdir(outputDir, { recursive: true });
		task.stage = t("canvas.skills.stagePreparing");
		task.phase = "preparing";
		const fileLines = [];
		const warnings = [];
		let index = 0;
		for (const input of inputs) {
			index += 1;
			const asset = input.asset;
			if (asset === void 0 || asset.assetId === "") {
				const text = nodeText(input.node);
				if (text !== "") {
					const name = `${String(index).padStart(2, "0")}_${input.node.type}-${input.node.id}.md`;
					await promises.writeFile(path.join(inputDir, name), text, "utf8");
					fileLines.push(`- ${path.join(inputDir, name)}（文本节点内容）`);
				}
				continue;
			}
			const safe = (asset.name ?? `${asset.assetId}`).replace(/[\\/:*?"<>|]/g, "_").slice(0, 80) || "input";
			const name = `${String(index).padStart(2, "0")}_${safe}`;
			const target2 = path.join(inputDir, name);
			await canvas.materialize(asset, target2);
			fileLines.push(`- ${target2}`);
		}
		if (fileLines.length === 0) throw new Error(t("canvas.skills.noInput"));
		task.stage = t("canvas.skills.stagePrepared", { count: fileLines.length });
		const skillName = this.heavySkillName(skill);
		const body = await this.loadSkillBody(skillName);
		if (body === void 0) throw new Error(t("canvas.skills.skillMissing", { name: skillName }));
		const configNote = await this.backend.skillConfig?.note(skillName).catch(() => void 0);
		const systemPrompt = this.heavySystemPrompt(skill, body, fileLines, outputDir, t, configNote);
		task.stage = t("canvas.skills.stageRunning");
		task.phase = "running";
		const controller = new AbortController();
		const timeout = this.options.heavyTimeoutMs();
		const timer = timeout > 0 ? setTimeout(() => controller.abort(), timeout) : void 0;
		timer?.unref?.();
		let handle;
		try {
			handle = await agents.create({
				sessionId: newId("skillagent"),
				cwd: runDir,
				systemPrompt,
				signal: controller.signal,
				fail: (key) => t(key)
			});
			if (handle === void 0) throw new Error(t("canvas.skills.agentFailed"));
			this.cancellers.set(task.id, { dispose: async () => {
				controller.abort();
				handle?.cancel();
				await handle?.dispose().catch(() => {});
			} });
			handle.followup(this.heavyUserPrompt(skill, skillName, inputDir, outputDir, body !== void 0, t));
			const watch = this.watchOutputDir(task, outputDir, t);
			try {
				await handle.whenIdle();
			} finally {
				watch.stop();
			}
			task.stage = t("canvas.skills.stageCollecting");
			task.phase = "collecting";
			const answer = lastAssistantText(handle.session.deriveMessages());
			return await this.collectHeavyOutput(task, skill, target, outputDir, answer, warnings, t);
		} finally {
			if (timer !== void 0) clearTimeout(timer);
			await handle?.dispose().catch(() => {});
		}
	}
	/** Report newly produced output files on the task while the agent works, so
	*  the canvas run card shows "已产出 N 个文件" instead of a silent spinner. */
	watchOutputDir(task, outputDir, t) {
		let seen = -1;
		const timer = setInterval(() => {
			promises.readdir(outputDir, {
				recursive: true,
				withFileTypes: true
			}).then((entries) => {
				const count = entries.filter((entry) => entry.isFile()).length;
				if (count === 0 || count === seen) return;
				seen = count;
				task.stage = t("canvas.skills.stageArtifacts", { count });
			}).catch(() => {});
		}, 2e3);
		timer.unref?.();
		return { stop: () => clearInterval(timer) };
	}
	/** The host skill name a heavy built-in maps to (the deck pipeline). */
	heavySkillName(skill) {
		if (skill.id.startsWith("skill:")) return skill.id.slice(6);
		if (skill.id === "ppt.fromImages") return EDITABLE_PPT_SKILL;
		return skill.name;
	}
	async loadSkillBody(name) {
		const registry = this.backend.registry;
		if (registry === void 0) return void 0;
		const definition = await registry.get(name).catch(() => void 0);
		if (definition === void 0 || definition.content.trim() === "") return void 0;
		return definition.content;
	}
	heavySystemPrompt(skill, body, fileLines, outputDir, t, configNote) {
		return [
			t("canvas.skills.heavyIntro", { name: skill.name }),
			...body === void 0 ? [] : [
				"",
				t("canvas.skills.heavyBodyHeader"),
				body
			],
			...configNote === void 0 || configNote === "" ? [] : [
				"",
				t("canvas.skills.configHeader"),
				configNote
			],
			"",
			t("canvas.skills.heavyInputsHeader"),
			...fileLines,
			"",
			t("canvas.skills.heavyOutputHeader", { dir: outputDir }),
			t("canvas.skills.heavyRules")
		].join("\n");
	}
	heavyUserPrompt(skill, skillName, inputDir, outputDir, hasBody, t) {
		return [
			t("canvas.skills.heavyAsk", { name: skill.name }),
			"",
			t("canvas.skills.heavyAskInputs", { dir: inputDir }),
			t("canvas.skills.heavyAskOutput", { dir: outputDir }),
			...hasBody ? [] : ["", t("canvas.skills.heavyAskLoadSkill", { name: skillName })]
		].join("\n");
	}
	async collectHeavyOutput(task, skill, target, outputDir, answer, warnings, t) {
		const canvas = this.backend.canvas;
		const files = [];
		const walk = async (dir, depth) => {
			if (depth > 3) return;
			let entries;
			try {
				entries = await promises.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				const full = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					await walk(full, depth + 1);
					continue;
				}
				if (!entry.isFile()) continue;
				const stat = await promises.stat(full).catch(() => void 0);
				if (stat === void 0 || stat.size === 0) continue;
				files.push({
					file: full,
					size: stat.size
				});
			}
		};
		await walk(outputDir, 0);
		const nodes = [];
		const connections = [];
		for (const found of files.sort((a, b) => a.file.localeCompare(b.file))) {
			const data = await promises.readFile(found.file).catch(() => void 0);
			if (data === void 0) continue;
			const name = path.basename(found.file);
			const asset = await canvas.putFile({
				data,
				mime: mimeFromName(name),
				name,
				origin: "generated",
				originId: task.id
			});
			const node = fileOutputNode(target.node, asset, name, skill.id, skill.name, [target.node.id]);
			nodes.push(node);
			connections.push({
				id: newId("edge"),
				fromNodeId: target.node.id,
				toNodeId: node.id
			});
		}
		if (nodes.length === 0) {
			const text = answer ?? "";
			if (text !== "") {
				const node = textOutputNode(target.node, skill.name, text, skill.id, skill.name, [target.node.id]);
				nodes.push(node);
				connections.push({
					id: newId("edge"),
					fromNodeId: target.node.id,
					toNodeId: node.id
				});
			}
			warnings.push(t("canvas.skills.noOutputFile"));
		}
		return outputOf(nodes, connections, warnings);
	}
	/**
	* Resolve copy for one run's language, falling back to the host-installed
	* resolver when the caller sent none.
	* @param language - the caller's UI language, when it sent one.
	*/
	translate(language) {
		return canvasSkillCopy(language);
	}
};
/** Minimal extension→MIME map for produced files (the store validates again). */
function mimeFromName(name) {
	switch (path.extname(name).replace(/^\./, "").toLowerCase()) {
		case "pptx": return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
		case "docx": return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
		case "xlsx": return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
		case "pdf": return "application/pdf";
		case "json": return "application/json";
		case "csv": return "text/csv";
		case "md": return "text/markdown";
		case "txt": return "text/plain";
		case "zip": return "application/zip";
		case "png": return "image/png";
		case "jpg":
		case "jpeg": return "image/jpeg";
		case "webp": return "image/webp";
		default: return "application/octet-stream";
	}
}
/** Copy resolver shared with the browser bundle (see locale-tables.ts). */
let translateHook = (key) => key;
/** Install the real copy resolver (host half wires the locale dictionaries). */
function setSkillTranslate(hook) {
	translateHook = hook;
}
function translateCanvasSkill(key, params, language) {
	return translateHook(key, params, language);
}
/**
* Active UI language for host-rendered copy. A run request carries no locale, so
* the host half installs a resolver here; without one the host answers in
* English (the browser half always renders its own copy through `tt`).
*/
let languageHook = () => "en";
/** Install the active-language resolver. */
function setSkillLanguage(hook) {
	languageHook = hook;
}
function currentSkillLanguage() {
	try {
		return languageHook();
	} catch {
		return "zh";
	}
}
/**
* Copy resolver for host-rendered canvas copy outside a run (the skill library
* panel): the caller's language wins, the installed language resolver backs it
* up, exactly as {@link SkillRunner.translate} does for runs.
* @param language - the caller's UI language, when it sent one.
*/
function canvasSkillCopy(language) {
	const preferred = language !== void 0 && language !== "" ? language : void 0;
	return (key, params) => translateCanvasSkill(key, params, preferred ?? currentSkillLanguage());
}
//#endregion
//#region src/skill-store.ts
/**
* Local skill library (`~/.dsh/skills`).
*
* The canvas offers every model-invocable host skill, but the interesting
* long-running ones (deck/document pipelines) are user-installed. This module
* is the host side of that story: it inspects the library, installs skills from
* a git URL / archive URL / raw `SKILL.md` URL, installs an archive the user
* uploaded through the canvas, and removes an installed skill.
*
* Install safety rules:
*
*  - everything lands under the resolved skills root; every destination path is
*    re-checked with `path.relative` before it is written or deleted;
*  - an archive is extracted into a staging directory first and only promoted
*    when it actually contains a `SKILL.md` with a frontmatter `name`;
*  - archives are read through the same bounded ZIP reader as OOXML extraction,
*    and the expanded size is capped;
*  - `git` runs with a timeout in a non-interactive mode on a fixed executable
*    name (no shell), and its failure is reported as actionable copy.
*
* The filesystem skill provider watches `~/.dsh/skills`, so an install becomes
* visible to `ctx.skills` without restarting the host.
*/
/** Hard cap on one downloaded archive / unpacked skill folder. */
const MAX_SKILL_ARCHIVE_BYTES = 64 * 1024 * 1024;
/** Cap on a single `SKILL.md` fetched from a raw URL. */
const MAX_SKILL_MARKDOWN_BYTES = 2 * 1024 * 1024;
/** Wall-clock cap for one install source. */
const INSTALL_TIMEOUT_MS = 18e4;
/** Canonical install sources this plugin knows by name (one-click affordances). */
const KNOWN_SKILL_SOURCES = [{
	name: "image-to-editable-ppt",
	url: "https://github.com/ningzimu/image-to-editable-ppt-skill"
}];
/** The upstream home of a known skill, when we know it. */
function knownSkillUrl(name) {
	return KNOWN_SKILL_SOURCES.find((entry) => entry.name === name)?.url;
}
/** Resolve the skills root: `DSH_HOME/skills` when known, else `~/.dsh/skills`. */
function skillsRoot(dshHome) {
	const home = (dshHome ?? process.env.DSH_HOME ?? "").trim();
	const base = home === "" ? path.join(homedir(), ".dsh") : home;
	return path.join(base, "skills");
}
/** A user-facing failure carrying actionable copy. */
var SkillStoreError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "SkillStoreError";
	}
};
/** Whether a name is a safe folder name for one skill. */
function isValidSkillName(name) {
	return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name) && name !== "." && name !== "..";
}
/**
* The public DSH skill-name grammar: lowercase kebab-case.
*
* This is stricter than {@link isValidSkillName} on purpose. The folder-name
* check only keeps a destination path safe, while the host skill registry
* publishes a bundle under its frontmatter `name` and *drops the whole skill*
* when that name is not kebab-case — silently, with nothing but a host log line.
* Every install and every locally discovered skill is checked against this
* grammar so the canvas can never offer something the host would ignore.
*/
const DSH_SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Whether a name is the kebab-case name the host skill registry loads. */
function isDshSkillName(name) {
	return DSH_SKILL_NAME.test(name);
}
/** Directory size in bytes (bounded walk), or 0 when it cannot be read. */
async function directorySize(root, depth = 0) {
	if (depth > 6) return 0;
	let total = 0;
	let entries;
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		return 0;
	}
	for (const entry of entries) {
		const full = path.join(root, entry.name);
		if (entry.isDirectory()) {
			total += await directorySize(full, depth + 1);
			continue;
		}
		if (!entry.isFile()) continue;
		const info = await stat(full).catch(() => void 0);
		if (info !== void 0) total += info.size;
	}
	return total;
}
/** The opening fence of a `SKILL.md` head, body excluded. */
const FRONTMATTER_HEAD = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
/** The same fence as a whole match, for stripping a body out of a file. */
const FRONTMATTER_WHOLE = /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
/** The boolean spellings the host's frontmatter reader accepts. */
function booleanOf(raw) {
	switch (raw.trim().toLowerCase()) {
		case "true":
		case "yes":
		case "on":
		case "1": return true;
		case "false":
		case "no":
		case "off":
		case "0": return false;
		default: return;
	}
}
/** Strip one matching pair of surrounding quotes from a scalar value. */
function unquote(value) {
	const text = value.trim();
	const quote = text[0];
	if ((quote === "\"" || quote === "'") && text.length > 1 && text.endsWith(quote)) return text.slice(1, -1).trim();
	return text;
}
/**
* Read a skill bundle's frontmatter. The DSH skill format uses a YAML head
* between `---` fences and wants `name` plus `description`; this reader covers
* the scalar and block-scalar spellings real bundles use (a folded
* `description: >-` must not surface as the literal text `>-`).
* @param markdown - the `SKILL.md` contents.
*/
function parseSkillFrontmatter(markdown) {
	const match = FRONTMATTER_HEAD.exec(markdown);
	if (match === null) return {
		present: false,
		invalidInvocation: false
	};
	const lines = match[1].split(/\r?\n/);
	const fields = /* @__PURE__ */ new Map();
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (line.trim() === "" || line.trim().startsWith("#") || /^\s/.test(line)) continue;
		const entry = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(line);
		if (entry === null) continue;
		const key = entry[1];
		let value = entry[2].trim();
		const block = /^([|>])[+-]?\d*\s*$/.exec(value);
		if (block !== null) {
			const collected = [];
			while (index + 1 < lines.length && (lines[index + 1].trim() === "" || /^\s/.test(lines[index + 1]))) {
				index += 1;
				collected.push(lines[index].trim());
			}
			value = block[1] === ">" ? collected.join(" ").replace(/\s+/g, " ").trim() : collected.join("\n").trim();
		} else value = unquote(value);
		if (!fields.has(key)) fields.set(key, value);
	}
	const read = (key) => {
		const value = fields.get(key);
		return value === void 0 || value === "" ? void 0 : value;
	};
	const disable = read("disable-model-invocation");
	const user = read("user-invocable");
	const disableValue = disable === void 0 ? void 0 : booleanOf(disable);
	const userValue = user === void 0 ? void 0 : booleanOf(user);
	return {
		present: true,
		...read("name") === void 0 ? {} : { name: read("name") },
		...read("description") === void 0 ? {} : { description: read("description") },
		...read("whenToUse") === void 0 ? {} : { whenToUse: read("whenToUse") },
		...disableValue === void 0 ? {} : { disableModelInvocation: disableValue },
		...userValue === void 0 ? {} : { userInvocable: userValue },
		invalidInvocation: disable !== void 0 && disableValue === void 0 || user !== void 0 && userValue === void 0
	};
}
/** First meaningful line of a skill body, used when frontmatter has no blurb. */
function firstHeading(markdown) {
	const withoutHead = markdown.replace(FRONTMATTER_WHOLE, "");
	for (const raw of withoutHead.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "") continue;
		return line.replace(/^#+\s*/, "").slice(0, 240);
	}
	return "";
}
/**
* Judge one bundle against the host registry's rules: a kebab-case frontmatter
* `name`, a frontmatter `description`, a parseable invocation spelling, and
* model invocation left permitted. Anything else is invisible to every agent,
* which is exactly what the canvas must not pretend to offer.
* @param markdown - the `SKILL.md` contents.
*/
function inspectSkillMarkdown(markdown) {
	const front = parseSkillFrontmatter(markdown);
	const name = front.name?.trim() ?? "";
	const base = {
		name,
		description: (front.description ?? firstHeading(markdown)).trim(),
		...front.whenToUse === void 0 ? {} : { whenToUse: front.whenToUse }
	};
	if (!front.present) return {
		...base,
		loadable: false,
		issue: "no-frontmatter"
	};
	if (!isDshSkillName(name)) return {
		...base,
		loadable: false,
		issue: "bad-name"
	};
	if ((front.description ?? "").trim() === "") return {
		...base,
		loadable: false,
		issue: "no-description"
	};
	if (front.invalidInvocation) return {
		...base,
		loadable: false,
		issue: "bad-invocation"
	};
	if (front.disableModelInvocation === true) return {
		...base,
		loadable: false,
		issue: "user-only"
	};
	return {
		...base,
		loadable: true
	};
}
/** Candidate skill files directly under `root` (the host scans one level). */
async function scanSkillFiles(root) {
	let children;
	try {
		children = await readdir(root, { withFileTypes: true });
	} catch {
		return [];
	}
	const files = [];
	for (const child of children) {
		if (child.isDirectory()) {
			if (child.name.startsWith(".")) continue;
			const markdown = path.join(root, child.name, "SKILL.md");
			if (existsSync(markdown)) files.push({
				folder: child.name,
				path: markdown
			});
			continue;
		}
		if (child.isFile() && child.name.toLowerCase().endsWith(".md")) files.push({
			folder: child.name.slice(0, -3),
			path: path.join(root, child.name)
		});
	}
	return files;
}
/** Read one candidate `SKILL.md`, bounded like a downloaded one. */
async function readSkillText(candidatePath) {
	const info = await stat(candidatePath).catch(() => void 0);
	if (info === void 0 || !info.isFile() || info.size > 2097152) return void 0;
	return await readFile(candidatePath, "utf8").catch(() => void 0);
}
/** The instruction body of one `SKILL.md` (frontmatter removed). */
function skillBody(markdown) {
	return markdown.replace(FRONTMATTER_WHOLE, "").trim();
}
/**
* Every skill under `root` the host registry would load, with its body.
*
* The canvas is a host surface with no session scope, so it cannot read the
* per-preset layer of `ctx.skills` (see `createSkillRegistryBackend`). Scanning
* the library directly is what lets the node skill menu agree with the skill
* library panel the user installed from.
* @param root - resolved skills root.
*/
async function listLocalSkills(root) {
	const skills = [];
	for (const candidate of await scanSkillFiles(root)) {
		const markdown = await readSkillText(candidate.path);
		if (markdown === void 0) continue;
		const inspection = inspectSkillMarkdown(markdown);
		if (!inspection.loadable) continue;
		skills.push({
			name: inspection.name,
			description: inspection.description,
			...inspection.whenToUse === void 0 ? {} : { whenToUse: inspection.whenToUse },
			path: candidate.path,
			content: skillBody(markdown)
		});
	}
	return skills.sort((a, b) => a.name.localeCompare(b.name));
}
/**
* Resolve one loadable local skill by the name the host registry publishes.
* @param root - resolved skills root.
* @param name - published skill name.
*/
async function readLocalSkill(root, name) {
	const wanted = name.trim();
	if (wanted === "") return void 0;
	return (await listLocalSkills(root)).find((skill) => skill.name === wanted);
}
/** One installed skill folder as the library reports it. */
async function entryOf(root, candidate, options) {
	const inspection = inspectSkillMarkdown(await readSkillText(candidate.path) ?? "");
	const name = inspection.name !== "" ? inspection.name : candidate.folder;
	const known = knownSkillUrl(name);
	const registryPath = options.known?.find((item) => item.name === name || item.name === candidate.folder)?.path;
	const info = await stat(candidate.path).catch(() => void 0);
	const issue = inspection.issue !== void 0 && options.issueText !== void 0 ? options.issueText(inspection.issue, name) : void 0;
	return {
		name,
		description: inspection.description,
		path: registryPath ?? candidate.path,
		sizeBytes: path.basename(candidate.path).toLowerCase() === "skill.md" ? await directorySize(path.dirname(candidate.path)) : info?.size ?? 0,
		updatedAt: info?.mtimeMs ?? Date.now(),
		...known === void 0 ? {} : { installUrl: known },
		...issue === void 0 ? {} : { issue }
	};
}
/**
* Inspect the library.
* @param options - skills root plus an optional authoritative name/path list
*   from the host registry (`ctx.skills`), which is preferred for `path`.
* @param options.root - resolved skills root.
* @param options.known - registry summaries, when the registry answered.
* @param options.networkAvailable - whether installs can be attempted at all.
* @param options.issueText - localizes "why the node menu cannot offer this"
*   for entries the host registry would ignore; omitted leaves it unsaid.
*/
async function listLibrary(options) {
	const entries = [];
	for (const candidate of await scanSkillFiles(options.root)) entries.push(await entryOf(options.root, candidate, options));
	entries.sort((a, b) => a.name.localeCompare(b.name));
	return {
		root: options.root,
		entries,
		catalog: KNOWN_SKILL_SOURCES.map((source) => ({ ...source })),
		networkAvailable: options.networkAvailable
	};
}
/** Strip a source URL down to something printable in an error message. */
function shortSource(source) {
	try {
		const url = new URL(source);
		return `${url.host}${url.pathname}`.slice(0, 120);
	} catch {
		return source.slice(0, 120);
	}
}
/**
* Classify one install source.
* @param source - user-supplied URL (git URL, archive URL, or SKILL.md URL).
*/
function classifySource(source) {
	const trimmed = source.trim();
	const github = /^https?:\/\/(?:www\.)?github\.com\/([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:\/(?:tree|blob)\/([^/\s]+)((?:\/[^\s#?]*)?))?\/?$/i.exec(trimmed);
	if (github !== null) {
		const subpath = (github[4] ?? "").replace(/^\/+/, "").replace(/\/+$/, "");
		return {
			kind: "github",
			owner: github[1],
			repo: github[2],
			ref: github[3] ?? "",
			subpath
		};
	}
	const raw = /^https?:\/\/raw\.githubusercontent\.com\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/(.+)$/i.exec(trimmed);
	if (raw !== null) return {
		kind: "raw",
		url: trimmed,
		name: (raw[4].split("/").filter((part) => part !== "").pop() ?? "SKILL.md").replace(/\.md$/i, "")
	};
	if (/\.zip(?:[?#].*)?$/i.test(trimmed)) return {
		kind: "archive",
		url: trimmed
	};
	return {
		kind: "git",
		url: trimmed,
		name: (trimmed.split(/[?#]/)[0].replace(/\/+$/, "").split("/").pop() ?? "").replace(/\.git$/i, "")
	};
}
/** Download one URL into memory with a byte cap. */
async function download(url, maxBytes, signal) {
	let response;
	try {
		response = await fetch(url, {
			redirect: "follow",
			signal,
			headers: {
				"user-agent": "dsh-imagegen-skill-installer",
				accept: "*/*"
			}
		});
	} catch (error) {
		throw new SkillStoreError(`下载失败：${error instanceof Error ? error.message : String(error)}`);
	}
	if (!response.ok) throw new SkillStoreError(`下载失败：HTTP ${response.status}`);
	const length = Number(response.headers.get("content-length") ?? "0");
	if (Number.isFinite(length) && length > maxBytes) throw new SkillStoreError("文件超过大小上限");
	const data = Buffer.from(await response.arrayBuffer());
	if (data.length > maxBytes) throw new SkillStoreError("文件超过大小上限");
	return data;
}
/** Run a command without a shell and collect its output (bounded by a timer). */
function run(command, args, options) {
	return new Promise((resolve) => {
		let settled = false;
		const child = spawn(command, args, {
			cwd: options.cwd,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			env: {
				...process.env,
				GIT_TERMINAL_PROMPT: "0",
				GIT_ASKPASS: "echo"
			}
		});
		let output = "";
		const collect = (chunk) => {
			if (output.length < 8e3) output += chunk.toString("utf8");
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			resolve({
				code: -1,
				output: `${output}\n安装超时`
			});
		}, options.timeoutMs);
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				code: -1,
				output: String(error.message)
			});
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				code: code ?? -1,
				output
			});
		});
	});
}
/** Expand a ZIP archive into `target`, refusing paths that escape it. */
async function extractArchive(data, target) {
	const entries = readZipDirectory(data);
	if (entries.length === 0) throw new SkillStoreError("压缩包无法解析（不是有效的 ZIP）");
	let written = 0;
	let expanded = 0;
	for (const entry of entries) {
		const relative = entry.name.replace(/\\/g, "/").replace(/^\/+/, "");
		if (relative === "" || relative.includes("..")) continue;
		const destination = path.resolve(target, relative);
		if (path.relative(target, destination).startsWith("..")) continue;
		if (isZipDirectory(entry)) {
			await mkdir(destination, { recursive: true });
			continue;
		}
		const bytes = readZipEntry(data, entry, MAX_SKILL_ARCHIVE_BYTES);
		if (bytes === void 0) continue;
		expanded += bytes.length;
		if (expanded > 67108864) throw new SkillStoreError("压缩包解压后超过大小上限");
		await mkdir(path.dirname(destination), { recursive: true });
		await writeFile(destination, bytes);
		written += 1;
	}
	if (written === 0) throw new SkillStoreError("压缩包内没有可安装的文件");
	return written;
}
/** Find the folder that actually holds `SKILL.md` inside an extracted tree. */
async function findSkillRoot(root) {
	if (existsSync(path.join(root, "SKILL.md"))) return root;
	let children;
	try {
		children = await readdir(root, { withFileTypes: true });
	} catch {
		return;
	}
	const dirs = children.filter((child) => child.isDirectory());
	for (const dir of dirs) {
		const candidate = path.join(root, dir.name);
		if (existsSync(path.join(candidate, "SKILL.md"))) return candidate;
	}
	if (dirs.length === 1) return await findSkillRoot(path.join(root, dirs[0].name));
}
/** `fs.rename` can fail across volumes; fall back to a recursive copy. */
async function moveInto(from, to) {
	try {
		await rename(from, to);
	} catch {
		await cp(from, to, { recursive: true });
		await rm(from, {
			recursive: true,
			force: true
		});
	}
}
/**
* The name one staged bundle installs under, or an actionable refusal.
*
* A bundle the host registry cannot load is never worth installing: its
* frontmatter name must be kebab-case, its description present, and its
* invocation spellings parseable. The folder fallback is only a *label* — the
* host publishes the frontmatter name, so a fallback cannot rescue a bundle
* whose own frontmatter is unusable.
* @param markdown - the staged `SKILL.md` contents.
*/
function installableSkillName(markdown) {
	const inspection = inspectSkillMarkdown(markdown);
	switch (inspection.issue) {
		case "no-frontmatter": throw new SkillStoreError("SKILL.md 缺少 YAML frontmatter（--- 开头的 name / description），本机技能注册表不会加载它");
		case "bad-name": throw new SkillStoreError(`SKILL.md 的 frontmatter name「${inspection.name}」不是 kebab-case（只能小写字母、数字和连字符），本机技能注册表会忽略它`);
		case "no-description": throw new SkillStoreError("SKILL.md 的 frontmatter 缺少 description（必填），本机技能注册表不会加载它");
		case "bad-invocation": throw new SkillStoreError("SKILL.md 的 disable-model-invocation / user-invocable 写法无法解析，本机技能注册表会忽略它");
		default: return inspection.name;
	}
}
/** Move a staged skill bundle into the library under its published name. */
async function promote(staged, root, force) {
	const skillRoot = await findSkillRoot(staged);
	if (skillRoot === void 0) throw new SkillStoreError("该来源里没有找到 SKILL.md");
	const markdown = await readFile(path.join(skillRoot, "SKILL.md"), "utf8").catch(() => "");
	if (markdown.trim() === "") throw new SkillStoreError("SKILL.md 是空文件");
	const name = installableSkillName(markdown);
	if (!isValidSkillName(name)) throw new SkillStoreError(`技能名「${name}」不能用作目录名，请改名后重新安装`);
	const destination = path.resolve(root, name);
	if (path.relative(root, destination).startsWith("..")) throw new SkillStoreError("技能名不合法");
	if (existsSync(destination) && !force) throw new SkillStoreError(`技能「${name}」已经安装（可勾选覆盖安装）`);
	await rm(destination, {
		recursive: true,
		force: true
	});
	await mkdir(root, { recursive: true });
	await moveInto(skillRoot, destination);
	return name;
}
/**
* Install one skill from an uploaded archive, or from a folder of files.
* @param data - archive bytes.
* @param root - skills root.
* @param _fallbackName - accepted for signature compatibility only: the
*   frontmatter `name` is authoritative, because that is the name the host
*   registry publishes (a bundle without one is refused, not renamed).
* @param force - replace an existing skill of the same name.
*/
async function installFromArchive(data, root, _fallbackName, force) {
	const staging = await mkdtemp(path.join(tmpdir(), "dsh-imagegen-skill-"));
	try {
		await extractArchive(data, staging);
		return await promote(staging, root, force);
	} finally {
		await rm(staging, {
			recursive: true,
			force: true
		}).catch(() => {});
	}
}
/**
* Install one skill from a URL: a GitHub folder, a raw `SKILL.md`, an archive,
* or any other git remote.
* @param source - the URL the user supplied.
* @param root - skills root.
* @param options - `force` replaces an existing install; `signal` aborts.
*   `fallbackName` only names a *diagnostic* for a source with no bundle; the
*   frontmatter name is what the host registry publishes.
*/
async function installFromUrl(source, root, options) {
	const kind = classifySource(source);
	if (kind.kind === "raw") {
		const data = await download(kind.url, MAX_SKILL_MARKDOWN_BYTES, options.signal);
		const name = installableSkillName(data.toString("utf8"));
		if (!isValidSkillName(name)) throw new SkillStoreError(`技能名「${name}」不能用作目录名，请改用仓库地址安装`);
		const destination = path.resolve(root, name);
		if (path.relative(root, destination).startsWith("..")) throw new SkillStoreError("技能名不合法");
		if (existsSync(destination) && !options.force) throw new SkillStoreError(`技能「${name}」已经安装（可勾选覆盖安装）`);
		await rm(destination, {
			recursive: true,
			force: true
		});
		await mkdir(destination, { recursive: true });
		await writeFile(path.join(destination, "SKILL.md"), data);
		return name;
	}
	if (kind.kind === "github") {
		const ref = kind.ref === "" ? "HEAD" : kind.ref;
		const data = await download(`https://codeload.github.com/${kind.owner}/${kind.repo}/zip/${encodeURIComponent(ref)}`, MAX_SKILL_ARCHIVE_BYTES, options.signal);
		const staging = await mkdtemp(path.join(tmpdir(), "dsh-imagegen-skill-"));
		try {
			await extractArchive(data, staging);
			const wanted = kind.subpath === "" ? staging : path.resolve(staging, kind.subpath);
			return await promote(existsSync(wanted) ? wanted : staging, root, options.force);
		} finally {
			await rm(staging, {
				recursive: true,
				force: true
			}).catch(() => {});
		}
	}
	if (kind.kind === "archive") {
		const data = await download(kind.url, MAX_SKILL_ARCHIVE_BYTES, options.signal);
		const tail = shortSource(kind.url).split("/").pop() ?? "skill";
		return await installFromArchive(data, root, options.fallbackName ?? tail.replace(/\.zip$/i, ""), options.force);
	}
	const staging = await mkdtemp(path.join(tmpdir(), "dsh-imagegen-skill-"));
	try {
		const result = await run("git", [
			"clone",
			"--depth",
			"1",
			"--quiet",
			kind.url,
			path.join(staging, "repo")
		], {
			cwd: staging,
			timeoutMs: INSTALL_TIMEOUT_MS
		});
		if (result.code !== 0) throw new SkillStoreError(`git clone 失败：${result.output.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`);
		await rm(path.join(staging, "repo", ".git"), {
			recursive: true,
			force: true
		});
		return await promote(path.join(staging, "repo"), root, options.force);
	} finally {
		await rm(staging, {
			recursive: true,
			force: true
		}).catch(() => {});
	}
}
/** One local candidate whose published name matches, for a remove by name. */
async function publishedSkillFile(root, name) {
	for (const candidate of await scanSkillFiles(root)) {
		const markdown = await readSkillText(candidate.path);
		if (markdown === void 0) continue;
		if (inspectSkillMarkdown(markdown).name === name) return candidate.path;
	}
}
/**
* Remove one installed skill. The name may be the folder name or the
* frontmatter name the panel listed (they differ whenever an author renamed
* their skill after the first release).
* @param name - the skill's published or folder name inside the library.
* @param root - skills root.
*/
async function removeSkill(name, root) {
	const trimmed = name.trim();
	if (trimmed === "" || trimmed === "." || trimmed === ".." || /[\\/]/.test(trimmed)) throw new SkillStoreError("技能名不合法");
	const dir = path.resolve(root, trimmed);
	if (path.relative(root, dir).startsWith("..")) throw new SkillStoreError("技能名不合法");
	const flat = path.resolve(root, `${trimmed}.md`);
	if (existsSync(dir)) {
		await rm(dir, {
			recursive: true,
			force: true
		});
		return trimmed;
	}
	if (existsSync(flat)) {
		await rm(flat, { force: true });
		return trimmed;
	}
	const published = await publishedSkillFile(root, trimmed);
	if (published === void 0) throw new SkillStoreError(`没有找到技能「${trimmed}」`);
	if (path.basename(published).toLowerCase() === "skill.md") await rm(path.dirname(published), {
		recursive: true,
		force: true
	});
	else await rm(published, { force: true });
	return trimmed;
}
//#endregion
//#region src/skill-config.ts
/**
* Per-skill configuration (`docs/skill-config.md`).
*
* Skills are data, so DSH itself has no notion of a skill setting; the canvas
* supplies one. A skill declares what it needs in a `skill.config.json` beside
* its `SKILL.md`, the panel renders a form from that declaration, the values
* live in this plugin's settings namespace, and "save and apply" runs the
* declared steps — the skill's own CLI (`editppt config …`) or a config file it
* reads. A built-in recipe covers well-known skills that ship no declaration.
*
* Everything here treats the declaration as untrusted data:
*
*  - parsing never executes anything and never writes a file;
*  - the manifest is bounded (fields, steps, content size) and versioned;
*  - `apply` runs only when the user clicks, with the exact argv shown first;
*  - commands run without a shell, from a fixed cwd, under a timeout;
*  - `file` targets expand `~`, refuse `..` escapes, and refuse the DSH home's
*    control files;
*  - secrets never reach the run prompt, the run directory, or a step's
*    reported detail/output.
*/
/** Cap on one declaration's fields / steps / file body. */
const MAX_CONFIG_FIELDS = 32;
const MAX_CONFIG_STEPS = 16;
const MAX_CONFIG_CONTENT_BYTES = 8 * 1024;
const MAX_CONFIG_LABEL_CHARS = 240;
/** Wall-clock cap for one `command` step. */
const COMMAND_TIMEOUT_MS = 18e4;
/** Cap on the command output kept for the panel. */
const MAX_COMMAND_OUTPUT_CHARS = 8e3;
/** Key one value inside the settings dictionaries. */
function skillConfigKey(skill, field) {
	return `${skill}/${field}`;
}
/** Coerce one dictionary-shaped settings value into a detached record. */
function asConfigDict(value) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
	const out = {};
	for (const [key, entry] of Object.entries(value)) if (typeof entry === "string") out[key] = entry;
	return out;
}
/** One field id the manifest may reference from `apply`. */
const FIELD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const FIELD_TYPES = /* @__PURE__ */ new Set([
	"string",
	"secret",
	"boolean",
	"number",
	"select"
]);
/** Trim one declaration string to its cap, or undefined when it is not text. */
function text(value, max) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed.slice(0, max);
}
/** Parse one `fields[]` entry. */
function parseField(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const entry = raw;
	const id = typeof entry.id === "string" ? entry.id.trim() : "";
	if (!FIELD_ID.test(id)) return void 0;
	const type = typeof entry.type === "string" && FIELD_TYPES.has(entry.type) ? entry.type : "string";
	const label = text(entry.label, MAX_CONFIG_LABEL_CHARS) ?? id;
	const description = text(entry.description, MAX_CONFIG_LABEL_CHARS);
	const fallback = text(entry.default, MAX_CONFIG_CONTENT_BYTES);
	const options = type !== "select" || !Array.isArray(entry.options) ? void 0 : entry.options.map((option) => {
		if (option === null || typeof option !== "object") return void 0;
		const record = option;
		const value = text(record.value, MAX_CONFIG_LABEL_CHARS);
		if (value === void 0) return void 0;
		return {
			value,
			label: text(record.label, MAX_CONFIG_LABEL_CHARS) ?? value
		};
	}).filter((option) => option !== void 0).slice(0, 64);
	return {
		id,
		label,
		type,
		...description === void 0 ? {} : { description },
		...entry.required === true ? { required: true } : {},
		...fallback === void 0 ? {} : { default: fallback },
		...options === void 0 || options.length === 0 ? {} : { options },
		...type === "secret" ? {} : entry.expose === true ? { expose: true } : {}
	};
}
/** Parse one `apply[]` entry. */
function parseStep(raw) {
	if (raw === null || typeof raw !== "object") return void 0;
	const entry = raw;
	const when = entry.when !== null && typeof entry.when === "object" ? entry.when : void 0;
	const guard = when === void 0 || typeof when.field !== "string" || !FIELD_ID.test(when.field.trim()) ? void 0 : {
		field: when.field.trim(),
		set: when.set !== false
	};
	const kind = typeof entry.kind === "string" ? entry.kind : "";
	if (kind === "command") {
		if (!Array.isArray(entry.argv)) return void 0;
		const argv = entry.argv.map((part) => typeof part === "string" ? part.trim() : "").filter((part) => part !== "").slice(0, 32);
		if (argv.length === 0) return void 0;
		return {
			kind: "command",
			argv,
			cwd: entry.cwd === "skill" ? "skill" : "run",
			...guard === void 0 ? {} : { when: guard }
		};
	}
	if (kind === "file") {
		const target = text(entry.path, 1024);
		const content = typeof entry.content === "string" ? entry.content : void 0;
		if (target === void 0 || content === void 0) return void 0;
		if (content.length > MAX_CONFIG_CONTENT_BYTES) return void 0;
		return {
			kind: "file",
			path: target,
			content,
			...guard === void 0 ? {} : { when: guard }
		};
	}
}
/**
* Validate one declaration object.
* @param raw - parsed JSON (or any value).
* @returns the bounded manifest, or the issue that made it unusable.
*/
function parseSkillConfigManifest(raw) {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { issue: "unreadable" };
	const entry = raw;
	if (entry.version !== 1) return { issue: "unsupported-version" };
	const fields = (Array.isArray(entry.fields) ? entry.fields : []).map(parseField).filter((field) => field !== void 0).slice(0, MAX_CONFIG_FIELDS);
	const steps = (Array.isArray(entry.apply) ? entry.apply : []).map(parseStep).filter((step) => step !== void 0).slice(0, MAX_CONFIG_STEPS);
	if (fields.length === 0 && steps.length === 0) return { issue: "empty" };
	const note = text(entry.note, MAX_CONFIG_LABEL_CHARS);
	return { manifest: {
		fields,
		steps,
		...note === void 0 ? {} : { note }
	} };
}
/** Read `<bundleDir>/skill.config.json` when the bundle has one. */
async function readSkillConfigFile(bundleDir) {
	const file = path.join(bundleDir, "skill.config.json");
	if (!existsSync(file)) return void 0;
	let raw;
	try {
		raw = JSON.parse(await readFile(file, "utf8"));
	} catch {
		return { issue: "unreadable" };
	}
	return parseSkillConfigManifest(raw);
}
/** Current values for one skill, secrets included (host side only). */
function valuesFor(declaration, store, skill) {
	const values = /* @__PURE__ */ new Map();
	for (const field of declaration.manifest.fields) {
		const key = skillConfigKey(skill, field.id);
		const stored = field.type === "secret" ? store.secrets[key] : store.values[key];
		values.set(field.id, typeof stored === "string" ? stored : field.default ?? "");
	}
	return values;
}
/** Labels of required fields with no value yet, in declaration order. */
function missingFields(declaration, values) {
	return declaration.manifest.fields.filter((field) => field.required === true && (values.get(field.id) ?? "").trim() === "").map((field) => field.label);
}
/**
* The panel-facing view of one skill's configuration. An ignored declaration
* still reports why, so the author sees the typo instead of an empty panel.
* @param declaration - validated declaration, when there is one.
* @param values - resolved values (secrets included).
* @param issue - host-rendered copy for an ignored declaration, when any.
*/
function configView(declaration, values, issue) {
	if (declaration === void 0) return issue === void 0 ? void 0 : {
		fields: [],
		values: [],
		source: "skill",
		applicable: false,
		missing: [],
		issue
	};
	return {
		fields: declaration.manifest.fields,
		values: declaration.manifest.fields.map((field) => {
			const value = values.get(field.id) ?? "";
			return field.type === "secret" ? {
				id: field.id,
				set: value !== ""
			} : {
				id: field.id,
				set: value !== "",
				value
			};
		}),
		source: declaration.source,
		applicable: declaration.manifest.steps.length > 0,
		missing: missingFields(declaration, values),
		...declaration.manifest.note === void 0 ? {} : { note: declaration.manifest.note },
		...issue === void 0 ? {} : { issue }
	};
}
/**
* The non-secret "configured values" block a run may carry, or undefined when
* the declaration exposes nothing. Secrets never appear here.
* @param declaration - validated declaration.
* @param values - resolved values (secrets included; they are filtered out).
*/
function configNote(declaration, values) {
	const lines = declaration.manifest.fields.filter((field) => field.expose === true && field.type !== "secret").map((field) => {
		const value = (values.get(field.id) ?? "").trim();
		return value === "" ? void 0 : `- ${field.label}: ${value}`;
	}).filter((line) => line !== void 0);
	return lines.length === 0 ? void 0 : lines.join("\n");
}
/** Substitute `{field}` references; undefined when a referenced value is empty. */
function substitute(template, values) {
	const missing = [];
	return {
		text: template.replace(/\{([a-z0-9][a-z0-9-]{0,63})\}/g, (_match, id) => {
			const value = (values.get(id) ?? "").trim();
			if (value === "") {
				missing.push(id);
				return "";
			}
			return value;
		}),
		missing
	};
}
/** Whether one guarded step should run. */
function guardAllows(step, values) {
	const when = step.when;
	if (when === void 0) return true;
	const value = (values.get(when.field) ?? "").trim();
	return when.set ? value !== "" : value === "";
}
/**
* Resolve one `file` target: expand `~`, refuse `..` escapes, and refuse the
* DSH home's own control files (a declaration is untrusted, so the blast radius
* of one careless click stays small).
* @param raw - the declared path.
* @returns the absolute target, or a refusal code.
*/
function resolveConfigTarget(raw) {
	const trimmed = raw.trim();
	const expanded = trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\") ? path.join(homedir(), trimmed.slice(1)) : trimmed;
	if (!path.isAbsolute(expanded)) return { issue: "refused-path" };
	if (expanded.split(/[\\/]+/).includes("..")) return { issue: "refused-path" };
	const normalized = path.resolve(expanded);
	const home = (process.env.DSH_HOME ?? "").trim() === "" ? path.join(homedir(), ".dsh") : process.env.DSH_HOME.trim();
	const control = [
		"settings.yaml",
		"cordis.patch.yml",
		"cordis.yml"
	].map((name) => path.join(home, name));
	const profiles = path.join(home, "profiles");
	if (control.includes(normalized)) return { issue: "refused-path" };
	if (normalized === profiles || normalized.startsWith(`${profiles}${path.sep}`)) return { issue: "refused-path" };
	return { path: normalized };
}
/** Mask every secret value inside one report string. */
function mask(text, secrets) {
	let out = text;
	for (const secret of secrets) if (secret.trim().length >= 4) out = out.split(secret).join("•••");
	return out;
}
/** Run one command without a shell, bounded by a timer and an output cap. */
function runCommand(argv, options) {
	return new Promise((resolve) => {
		let settled = false;
		const child = spawn(argv[0], argv.slice(1), {
			cwd: options.cwd,
			windowsHide: true,
			stdio: [
				"ignore",
				"pipe",
				"pipe"
			],
			env: { ...process.env }
		});
		let output = "";
		const collect = (chunk) => {
			if (output.length < MAX_COMMAND_OUTPUT_CHARS) output += chunk.toString("utf8");
		};
		child.stdout?.on("data", collect);
		child.stderr?.on("data", collect);
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill();
			resolve({
				code: -1,
				output: `${output}\n超时（${Math.round(options.timeoutMs / 1e3)}s）`
			});
		}, options.timeoutMs);
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				code: -1,
				output: String(error.message)
			});
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				code: code ?? -1,
				output
			});
		});
	});
}
/** Write one file atomically, creating its parents. */
async function writeConfigFile(target, content) {
	await mkdir(path.dirname(target), { recursive: true });
	const temporary = `${target}.tmp-${process.pid.toString(36)}`;
	try {
		await writeFile(temporary, content, "utf8");
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		throw error;
	}
}
/**
* Execute a declaration's `apply` steps in order.
* @param declaration - validated declaration.
* @param values - resolved values (secrets included).
* @param options - `runRoot` is the default cwd; `skillDir` backs `cwd: 'skill'`;
*   `timeoutMs` overrides the per-command cap.
* @returns one result per declared step, in order (secrets masked).
*/
async function applySkillConfigSteps(declaration, values, options) {
	const secrets = declaration.manifest.fields.filter((field) => field.type === "secret").map((field) => values.get(field.id) ?? "");
	const results = [];
	const stepDir = (step) => {
		if (step.kind === "command" && step.cwd === "skill" && options.skillDir !== void 0) return options.skillDir;
		return options.runRoot;
	};
	for (const step of declaration.manifest.steps) {
		if (!guardAllows(step, values)) {
			results.push({
				step,
				ok: true,
				detail: "skipped"
			});
			continue;
		}
		if (step.kind === "command") {
			const substituted = step.argv.map((part) => substitute(part, values));
			const missing = [...new Set(substituted.flatMap((part) => part.missing))];
			const argv = substituted.map((part) => part.text);
			if (missing.length > 0) {
				results.push({
					step,
					ok: false,
					detail: mask(argv.join(" "), secrets),
					output: `缺少配置：${missing.join("、")}`
				});
				continue;
			}
			const outcome = await runCommand(argv, {
				cwd: stepDir(step),
				timeoutMs: options.timeoutMs ?? COMMAND_TIMEOUT_MS
			});
			const output = mask(outcome.output.trim().slice(-8e3), secrets);
			results.push({
				step,
				ok: outcome.code === 0,
				detail: mask(argv.join(" "), secrets),
				...output === "" ? {} : { output }
			});
			continue;
		}
		const target = resolveConfigTarget(step.path);
		if ("issue" in target) {
			results.push({
				step,
				ok: false,
				detail: step.path,
				output: "该路径不允许写入（只允许绝对路径 / ~ 展开，且不能写 DSH 主目录的控制文件）"
			});
			continue;
		}
		const rendered = substitute(step.content, values);
		if (rendered.missing.length > 0) {
			results.push({
				step,
				ok: false,
				detail: `→ ${target.path}`,
				output: `缺少配置：${[...new Set(rendered.missing)].join("、")}`
			});
			continue;
		}
		try {
			await writeConfigFile(target.path, rendered.text);
			results.push({
				step,
				ok: true,
				detail: `→ ${target.path}`
			});
		} catch (error) {
			results.push({
				step,
				ok: false,
				detail: `→ ${target.path}`,
				output: error instanceof Error ? error.message : String(error)
			});
		}
	}
	return results;
}
//#endregion
//#region src/skill-config-recipes.ts
/**
* Built-in configuration recipes for well-known skills.
*
* A skill should declare its own configuration in `skill.config.json` (see
* `docs/skill-config.md`); a recipe exists only so a known skill works out of
* the box for users who installed it from upstream before it shipped a
* declaration. A skill's own file always wins, so upstream can take over
* without a plugin release — the same relationship `KNOWN_SKILL_SOURCES` has
* with install links.
*
* Recipes are plugin-owned data, so they are trusted here: they still go
* through the same validation as an installed declaration, which keeps one
* grammar and one set of caps for both.
*/
/**
* The `image-to-editable-ppt` pipeline: it drives `editppt`, which reads
* `~/.editppt/config.yaml` and needs an OpenAI-compatible image endpoint for
* page background repair and asset separation. PaddleOCR is optional (the
* built-in offline detector still works), so its step is guarded.
*/
const RECIPES = [{
	name: EDITABLE_PPT_SKILL,
	declaration: {
		version: 1,
		note: "密钥只写入本机 ~/.editppt/config.yaml；不会进入运行目录、清单或提示词。页面素材需要任何 OpenAI 兼容的图像 API。",
		fields: [
			{
				id: "image-api-key",
				label: "图像 API 密钥",
				description: "用于页面背景修复与素材分离的 OpenAI 兼容图像 API 密钥",
				type: "secret",
				required: true
			},
			{
				id: "image-base-url",
				label: "API 地址",
				description: "OpenAI 兼容的 base URL，例如 https://api.openai.com/v1",
				type: "string",
				default: "https://api.openai.com/v1",
				expose: true
			},
			{
				id: "image-model",
				label: "图像模型",
				type: "string",
				default: "gpt-image-2",
				expose: true
			},
			{
				id: "paddle-ocr-token",
				label: "PaddleOCR token（可选）",
				description: "不填则使用内置离线文字检测；填了文字还原更准（免费额度）",
				type: "secret"
			}
		],
		apply: [{
			kind: "command",
			argv: [
				"editppt",
				"config",
				"--api-key",
				"{image-api-key}",
				"--base-url",
				"{image-base-url}",
				"--model",
				"{image-model}"
			]
		}, {
			kind: "command",
			argv: [
				"editppt",
				"config",
				"--paddle-ocr-token",
				"{paddle-ocr-token}"
			],
			when: {
				field: "paddle-ocr-token",
				set: true
			}
		}]
	}
}];
/** The built-in declaration for one skill, already validated. */
function recipeFor(skillName) {
	const recipe = RECIPES.find((entry) => entry.name === skillName);
	if (recipe === void 0) return void 0;
	const parsed = parseSkillConfigManifest(recipe.declaration);
	return parsed.manifest === void 0 ? void 0 : {
		manifest: parsed.manifest,
		source: "plugin"
	};
}
/** Skill names this plugin ships a configuration recipe for. */
function recipeNames() {
	return RECIPES.map((recipe) => recipe.name);
}
//#endregion
//#region src/index.ts
/**
* Resolve one skill's configuration declaration and the view the panel renders.
*
* Sidecar first, built-in recipe second, nothing third — the plugin never
* invents a configuration surface for a skill that declared none. Exported so
* the smoke suite exercises the real lookup (sidecar parsing, recipe fallback,
* value resolution) rather than a test double of it.
* @param options - skill name, its library entry path, the skills root, and the
*   live value store; `issueText` localizes an ignored declaration.
*/
async function readCanvasSkillConfig(options) {
	const candidates = [.../* @__PURE__ */ new Set([bundleDirOf(options.entryPath), path.join(options.root, options.name)])].filter((dir) => dir !== void 0);
	let declaration;
	let issue;
	for (const dir of candidates) {
		const found = await readSkillConfigFile(dir).catch(() => void 0);
		if (found === void 0) continue;
		if (found.manifest === void 0) issue = found.issue ?? "unreadable";
		else declaration = {
			manifest: found.manifest,
			source: "skill"
		};
		break;
	}
	if (declaration === void 0 && issue === void 0) declaration = recipeFor(options.name);
	const values = declaration === void 0 ? /* @__PURE__ */ new Map() : valuesFor(declaration, options.store, options.name);
	const view = configView(declaration, values, issue === void 0 ? void 0 : options.issueText === void 0 ? issue : options.issueText(issue));
	return {
		...declaration === void 0 ? {} : { declaration },
		...issue === void 0 ? {} : { issue },
		...view === void 0 ? {} : { view }
	};
}
/** The bundle directory a library entry points at, when it is a bundle. */
function bundleDirOf(entryPath) {
	if (entryPath === void 0) return void 0;
	return path.basename(entryPath).toLowerCase() === "skill.md" ? path.dirname(entryPath) : void 0;
}
/** Error text for user-facing copy (never a bare `[object Object]`). */
function messageOf(error) {
	return error instanceof Error ? error.message : String(error);
}
/**
* Compose the headless agent one heavy skill run drives.
*
* Creating an agent is not enough to make it *useful*: on the Web surface every
* model-facing row (tools, prompt sections) lives behind an agent preset, and a
* model route is not implied by the request. DSH's own entry points therefore
* always pass both — `dsh-api-session-controller` stamps `agentOptions` from the
* deployment default and mounts the resolved preset in `setup`, and
* `dsh-subagent` joins the parent's preset for the same reason ("a child that
* joins no preset sees an empty tool registry and none of its parent's prompt
* sections"). A skill pipeline that must run a CLI is exactly that case: without
* the join the agent dies on its first step, and without the model route it has
* nothing to think with, so the canvas fails the run up front with copy instead
* of producing an empty result.
* @param options - host seams plus the run's identity, workspace and skill body.
* @returns the live agent handle narrowed to what a skill run drives.
*/
async function createCanvasSkillAgent(options) {
	const requested = options.agentPreset.trim();
	const presetId = options.presets === void 0 ? void 0 : (await options.presets.resolve(requested === "" ? void 0 : requested)).id;
	const selection = options.defaultModel?.currentSelection();
	const provider = selection?.provider?.trim() ?? "";
	const model = selection?.model?.trim() ?? "";
	const fail = options.fail ?? ((key) => key);
	if (provider === "" || model === "") throw new Error(fail("canvas.skills.needModel"));
	const handle = await options.agents.create({
		sessionId: options.sessionId,
		meta: {
			cwd: options.cwd,
			origin: "subagent",
			...presetId === void 0 ? {} : { agentPreset: presetId }
		},
		agentOptions: {
			provider,
			model
		},
		...options.signal === void 0 ? {} : { signal: options.signal },
		setup: async (agentCtx) => {
			if (options.presets !== void 0 && presetId !== void 0) await options.presets.mount(agentCtx, presetId);
			agentCtx.systemPrompt.section({
				name: "plugin:dsh-imagegen:canvas-skill",
				order: SECTION_ORDER,
				text: options.systemPrompt
			});
		}
	});
	const agent = handle.agent;
	return {
		session: agent.session,
		followup: (body) => {
			agent.followup({
				id: `canvas-skill-${Date.now().toString(36)}`,
				role: "user",
				content: [{
					type: "text",
					text: body
				}],
				source: {
					kind: "plugin",
					plugin: "dsh-imagegen"
				}
			});
		},
		whenIdle: () => agent.whenIdle(),
		cancel: () => agent.cancel({ kind: "user" }),
		dispose: () => handle.dispose()
	};
}
/**
* Wrap the host skill registry for the canvas runner: only model-invocable
* skills are offered (the canvas runs every skill through a model, so a
* user-only slash-command skill would fail halfway), and the summary is
* narrowed to the fields the tier heuristic reads.
*
* The registry alone is not enough on the Web surface. There, a preset owns
* local discovery: `skill-filesystem` mounts into the *preset's* layer while
* this plugin is a host-plane bundle, and an unscoped `ctx.skills.list()` reads
* the global layer alone (the base host row is disabled — see
* `dsh-web-app/cordis.patch.yml`). Every skill the user installs into
* `~/.dsh/skills` would therefore be invisible to the canvas, even though the
* skill library panel lists it. So the local library is read straight from disk
* as a second source, and both `list` and `get` consult it — the disk source is
* also what makes a heavy run's body load without the agent's own scope.
*
* The canvas is one host surface shared by every session, so it deliberately
* offers the union: registry entries win a name collision (a deployment-level
* provider outranks a user install), and the local scan fills the rest.
* @param skills - the injected `ctx.skills` service.
* @param options - `root` resolves the local skill library root; omitted (as in
*   narrow harnesses) leaves only the registry source.
* @returns the runner's registry seam.
*/
function createSkillRegistryBackend(skills, options = {}) {
	const localRoot = () => options.root?.();
	const localSkills = async () => {
		const root = localRoot();
		if (root === void 0) return [];
		return await listLocalSkills(root).catch(() => []);
	};
	return {
		list: async () => {
			const listed = await skills.list();
			const merged = /* @__PURE__ */ new Map();
			for (const skill of await localSkills()) merged.set(skill.name, {
				name: skill.name,
				description: skill.description,
				...skill.whenToUse === void 0 ? {} : { whenToUse: skill.whenToUse },
				path: skill.path,
				source: "filesystem"
			});
			for (const summary of listed) {
				if (summary.invocation?.modelInvocable === false) continue;
				merged.set(summary.name, {
					name: summary.name,
					description: summary.description,
					...summary.whenToUse === void 0 ? {} : { whenToUse: summary.whenToUse },
					...summary.path === void 0 ? {} : { path: summary.path },
					...summary.metadata === void 0 ? {} : { metadata: summary.metadata }
				});
			}
			return [...merged.values()];
		},
		get: async (name) => {
			const definition = await skills.get(name);
			if (definition !== void 0) return {
				name: definition.name,
				content: definition.content,
				...definition.metadata === void 0 ? {} : { metadata: definition.metadata }
			};
			const root = localRoot();
			const local = root === void 0 ? void 0 : await readLocalSkill(root, name).catch(() => void 0);
			return local === void 0 ? void 0 : {
				name: local.name,
				content: local.content
			};
		}
	};
}
/** Content type for a saved image file name (object uploads). */
function mimeOfPath(filePath) {
	switch (path.extname(filePath).toLowerCase()) {
		case ".jpg":
		case ".jpeg": return "image/jpeg";
		case ".webp": return "image/webp";
		case ".gif": return "image/gif";
		default: return "image/png";
	}
}
/** Stable cordis plugin name. */
const name = "imagegen";
/** Services required before the surfaces can mount. */
const inject = [
	"webServer",
	"systemPrompt",
	"commands"
];
/** The branded settings namespace of this plugin (the card edits it). */
const ImageGenSettingsNamespace = settingsNamespaceCompat(IMAGEGEN_SETTINGS_NAMESPACE);
const Config = z.object({
	enabled: z.boolean().default(true).volatile(),
	announceToAgent: z.boolean().default(true).volatile(),
	allowAgentImageGeneration: z.boolean().default(true).volatile(),
	channels: z.array(z.object({
		id: z.string(),
		preset: z.string().default(""),
		name: z.string().default(""),
		apiUrl: z.string().default(""),
		apiUrlFull: z.boolean().default(false),
		protocol: z.union([
			z.const("auto"),
			z.const("images"),
			z.const("chat-completions")
		]).default("auto"),
		auth: z.union([z.const("api-key"), z.const("subscription")]).default("api-key"),
		subscription: z.string().default(""),
		models: z.array(z.object({
			alias: z.string(),
			id: z.string()
		})).default([])
	})).default([]).volatile(),
	channelSecrets: z.dict(z.string().role("secret")).default({}).volatile(),
	defaultChannelId: z.string().default("").volatile(),
	defaultModel: z.string().default("").volatile(),
	promptApiUrl: z.string().default("").volatile(),
	promptApiKey: z.string().role("secret").default("").volatile(),
	promptModel: z.string().default("").volatile(),
	localStoragePath: z.string().default("").volatile(),
	storageEnabled: z.boolean().default(false).volatile(),
	storageEndpoint: z.string().default("").volatile(),
	storageRegion: z.string().default("").volatile(),
	storagePrefix: z.string().default("dsh-imagegen").volatile(),
	storageAccessKey: z.string().default("").volatile(),
	storageSecretKey: z.string().role("secret").default("").volatile(),
	storageSyncGallery: z.boolean().default(true).volatile(),
	storageSyncHistory: z.boolean().default(false).volatile(),
	skillsEnabled: z.boolean().default(true).volatile(),
	allowHeavySkills: z.boolean().default(true).volatile(),
	skillAllowlist: z.string().default("").volatile(),
	skillOutputDir: z.string().default("").volatile(),
	skillHeavyTimeoutMinutes: z.number().default(20).volatile(),
	skillAgentPreset: z.string().default("").volatile(),
	skillConfig: z.dict(z.string()).default({}).volatile(),
	skillConfigSecrets: z.dict(z.string().role("secret")).default({}).volatile(),
	apiUrl: z.string().default("").volatile(),
	apiKey: z.string().role("secret").default("").volatile(),
	imageModels: z.array(z.string()).default([]).volatile()
});
/** Read a value that may be a volatile config reference. */
function unwrapVolatileValue(value) {
	if (typeof value === "object" && value !== null && typeof value.get === "function") return value.get();
	return value;
}
/** Detach the plain Config view from the loader's top-level volatile fields. */
function unwrapConfig(value) {
	if (typeof value !== "object" || value === null) return {};
	const out = {};
	for (const [key, field] of Object.entries(value)) out[key] = unwrapVolatileValue(field);
	return out;
}
/** Schema defaults, re-read for hand-built contexts (the loader applies them normally). */
const DEFAULT_ENABLED = true;
const DEFAULT_ANNOUNCE = true;
const DEFAULT_ALLOW_AGENT_IMAGE_GENERATION = true;
/** Order of the announcement section within the tool-guidance band. */
const SECTION_ORDER = 150;
/** Model-facing announcement: plugin presence, capabilities, and limits. */
const IMAGEGEN_GUIDANCE = "本机已安装 dsh-imagegen 插件（DSH AI 生图）：「设置 → 生图配置」，以及侧边栏「新会话 / 生图」工作台。能力：通过「渠道」对接 OpenAI 兼容图像生成 API（每个渠道 = 一个 API 端点 + 各自的模型目录），支持文生图（/images/generations）与图生图（/images/edits，上传参考图，grok-imagine 模型按官方 JSON image_url 协议发送，nanobanana 系列按 aspect_ratio / image_size 参数协议发送；seedream 系列统一走 /images/generations，参考图以 JSON image 数组发送；智谱 `glm-image` 使用官方 `/api/paas/v4/images/generations`，当前仅支持文生图；qwen-image 系列使用阿里云 DashScope 原生接口（api_url 填 https://dashscope.aliyuncs.com/api/v1，不支持 OpenAI 兼容模式，该渠道不可复用于提示词增强，尺寸自动映射为宽*高）。MiniMax `image-01` 使用 MiniMax 原生 `/image_generation` 接口（api_url 填 https://api.minimax.io/v1 或国内站 https://api.minimaxi.com/v1，支持 1:1/16:9/4:3/3:2/2:3/3:4/9:16/21:9 宽高比，一次最多 9 张；图生图为单张 subject_reference 主体参考（保持人物/主体一致，非像素级局部编辑）；其 /models 只列聊天模型，图片模型需用预设目录）。API 地址与密钥在 GUI 设置中按渠道配置，密钥仅存于本机设置文档；生成请求由本地宿主代理转发，结果以 base64 返回面板，可预览与下载。模型只能使用用户在各渠道配置目录中的模型；检测模型时会过滤聊天、Embedding 等非图片模型，但模型出现在 /models 中仍不等于其网关原生支持生图协议，遇到 Qwen、MiniMax、Gemini 等非 OpenAI 生图协议时应如实说明上游兼容性。可一键把满意的图片加入「画廊」。内置「提示词模板库」（面板提示词框左下角「模板库」按钮）：多来源标签页（精选案例库 / 沧河案例库 / 手绘模板库 / Prompt-Signal / GPT Image 2 案例库），内置多个社区库的数千条提示词案例，可搜索、筛选、收藏（星标，宿主持久化）与复用；在线来源可独立刷新并每 12 小时后台同步，手绘、Prompt-Signal 与 GPT Image 2 案例库使用随插件版本更新的固定快照。Agent 可直接调用 `generate_image` 提交文生图，也可用 `edit_image` 图生图；默认保持工具调用等待直到任务完成，完成图片显示在工具调用对应的左侧结果区域，模型收到状态和附件引用，不会额外伪造用户消息。用户也可以使用 `/edit_image <修改描述>`，命令会直接读取当前对话最近图片并调用插件图片模型，不经过对话模型的图片能力检查。若明确需要后台执行，可传 `wait_for_completion: false`，之后再用 `get_image_generation_task` 查询；不要反复轮询。限制：生成消耗上游 API 额度；图片内容由上游模型生成，可能不符合预期或包含不适宜内容；api_key 以明文存储在设置文档中；参考图会发送至所配置的 API 服务；模板库参考图首次加载需要访问对应来源站点（vibeui.top / gpt-image2.canghe.ai / cdn.jsdelivr.net / raw.githubusercontent.com / pbs.twimg.com / mosaic.fxtwitter.com）。用户提到「生图 / 绘画 / 生成图片 / 文生图 / 图生图 / 画廊 / 提示词模板」时即指本插件，请据此协作。无限画布的图片节点还有四个纯界面能力（标注局部改图：画框后挂一张跟随图片移动的提示词卡片、本地抠图去背景、按视觉模型拆分图层、为节点指定模型），它们由用户在画布上操作，Agent 无需也无法触发。无限画布现在还支持「技能」：任意图片/文本/文件节点（生成配置节点除外）的悬浮工具条或右键菜单都有「技能」入口，内置动作包括文本润色（polish.text，可指定 formal/casual/shorter/expand 或自定义指令）、图片描述（describe.image）、内容抽取（extract.content：文本/代码/OOXML/PDF 抽取为文本节点），以及重任务「图片转可编辑 PPT」（ppt.fromImages）；同时会列出本机 ~/.dsh/skills 下所有可被模型调用的技能（id 形如 skill:<名称>）。轻量技能直接调用「提示词增强」所配置的聊天模型；重任务技能会启动一个无头 DSH Agent 在本机执行真实流水线（读写文件、跑 CLI），可能持续数分钟到数十分钟并消耗较多额度，因此界面会先弹确认框。`image-to-editable-ppt` 需要用户自行安装该技能，并按它的文档配置 OCR Token 与图片后端，未安装时运行会返回可操作的 skill-missing 提示；底部 Dock 的「技能库」面板可以在线安装（粘贴仓库/压缩包/SKILL.md 链接，支持 GitHub、裸 git、raw 与 zip）或上传本地技能压缩包，也可以卸载，装好后宿主会热加载、无需重启。技能可以在 SKILL.md 旁边放 skill.config.json 声明自己需要的配置（字段 + apply 步骤：command 调技能自带 CLI、或写一份配置文件），技能库面板据此渲染「配置」表单并支持保存 / 保存并应用，密钥走设置脱敏存储、不会进入运行目录或提示词；已知技能（image-to-editable-ppt 的 editppt config）插件内置了配方，所以用户不需要手敲配置命令。文件节点支持拖拽或菜单上传任意文件（单文件 ≤50MB，脚本/可执行文件被拒绝），并在节点内直接预览内容：文本/代码/CSV/TSV/JSON 原文、XLSX 表格、DOCX/PPTX/ODT/ODS 抽取文本、ZIP 目录清单都由宿主解码成有限的预览数据返回，图片、PDF、音频、视频由宿主以 inline 响应（支持 HTTP Range，可拖动播放进度）交给浏览器渲染；双击节点或点悬浮工具条的「放大预览」会在全屏阅读器里显示全文并支持复制与下载，无法内联的二进制类型仍以下载方式提供（宿主以 application/octet-stream + attachment 返回，HTML/SVG 一类的标记永远不会内联渲染）。技能运行只产出节点与连线草稿，由浏览器端写入画布文档。相关设置在「设置 → 生图配置」的「无限画布技能」（总开关、是否允许重任务、技能白名单、重任务工作目录、超时分钟数、Agent 预设，并可一键检测技能环境）。";
/** Append the live channel × model table so an Agent can honor user choices. */
function guidanceFor(channels, defaultChannelId, defaultModel) {
	if (channels.length === 0) return `${IMAGEGEN_GUIDANCE} 尚未配置任何渠道：请先打开「设置 → 生图配置」添加渠道并填写 API 地址与密钥。`;
	const table = channels.map((channel) => {
		const aliases = channel.models.map((model) => model.alias).join("、");
		const mark = channel.id === defaultChannelId ? "（默认渠道）" : "";
		const key = channel.apiKey === "" ? "（未填密钥）" : "";
		const models = channel.models.length === 0 ? "未配置模型" : `可用模型：${aliases}`;
		return `渠道「${channel.name}」${mark}[${channel.apiUrl}] ${models}${key}`;
	}).join("；");
	const fallback = defaultModel === "" ? "未指定模型时若仅一个可用模型可直接生成，若有多个应先询问用户选择「渠道 + 模型」。" : `未指定模型时默认使用「${defaultModel}」。`;
	return `${IMAGEGEN_GUIDANCE} 当前渠道与模型：${table}。用户指定模型名时取该模型所属渠道（多渠道同名用默认渠道）；${fallback}`;
}
/** Normalize raw channel entries into the wire shape (schema-adjacent guard). */
function normalizeChannels(value) {
	if (!Array.isArray(value)) return [];
	const out = [];
	for (const item of value) {
		if (item === null || typeof item !== "object") continue;
		const raw = item;
		const id = typeof raw.id === "string" ? raw.id.trim() : "";
		if (id === "") continue;
		const models = [];
		if (Array.isArray(raw.models)) for (const entry of raw.models) {
			if (entry === null || typeof entry !== "object") continue;
			const record = entry;
			const alias = typeof record.alias === "string" ? record.alias.trim() : "";
			const upstream = typeof record.id === "string" ? record.id.trim() : "";
			if (alias === "") continue;
			models.push({
				alias,
				id: upstream === "" ? alias : upstream
			});
		}
		out.push({
			id,
			preset: typeof raw.preset === "string" ? raw.preset : "",
			name: typeof raw.name === "string" ? raw.name.trim() : "",
			apiUrl: typeof raw.apiUrl === "string" ? raw.apiUrl.trim() : "",
			apiUrlFull: raw.apiUrlFull === true,
			...isChannelProtocolPreference(raw.protocol) ? { protocol: raw.protocol } : {},
			...raw.auth === "subscription" ? { auth: "subscription" } : {},
			...isSubscriptionProvider(raw.subscription) ? { subscription: raw.subscription } : {},
			models
		});
	}
	return out;
}
/** Whether a channel can back the optional chat model without subscription routing. */
function isReusablePromptChannel(channel) {
	return channel.auth !== "subscription" && channel.apiUrlFull !== true && channel.apiUrl.trim() !== "";
}
/**
* Resolve the optional chat endpoint. Keeping this separate from image
* generation matters when subscription channels appear first: blank prompt
* fields must reuse a real API-key channel, not the first configured row.
*/
function resolvePromptModelConfig(value) {
	const reusable = [
		value.defaultModel === "" ? void 0 : value.channels.find((channel) => isReusablePromptChannel(channel) && channel.models.some((model) => model.alias === value.defaultModel)),
		value.channels.find((channel) => channel.id === value.defaultChannelId),
		...value.channels
	].find((channel) => channel !== void 0 && isReusablePromptChannel(channel));
	return {
		apiUrl: value.promptApiUrl !== "" ? value.promptApiUrl : reusable?.apiUrl ?? "",
		apiKey: value.promptApiKey !== "" ? value.promptApiKey : reusable?.apiKey ?? "",
		model: value.promptModel
	};
}
/**
* Mount the settings section, routes, and announcement.
* @param ctx - host plugin context carrying webServer/systemPrompt.
* @param config - resolved plugin config (schema defaults applied by the loader).
*/
function apply(ctx, config) {
	let current = () => ctx.fiber?.config ?? config ?? {};
	const resolve = () => {
		const value = unwrapConfig(current());
		setImageDataRoot(value.localStoragePath);
		let channels = normalizeChannels(value.channels);
		const secrets = { ...value.channelSecrets ?? {} };
		if (channels.length === 0) {
			const legacyUrl = typeof value.apiUrl === "string" ? value.apiUrl.trim() : "";
			const legacyModels = Array.isArray(value.imageModels) ? value.imageModels.filter((model) => typeof model === "string" && model.trim() !== "").map((model) => ({
				alias: model.trim(),
				id: model.trim()
			})) : [];
			if (legacyUrl !== "" || legacyModels.length > 0) {
				channels = [{
					id: "default",
					preset: "",
					name: "默认渠道",
					apiUrl: legacyUrl,
					apiUrlFull: false,
					models: legacyModels
				}];
				const legacyKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
				if (legacyKey !== "") secrets["default"] = legacyKey;
			}
		}
		const named = channels.map((channel) => ({
			...channel,
			name: channel.name === "" ? presetById(channel.preset)?.name ?? "未命名渠道" : channel.name
		}));
		const defaultChannelId = typeof value.defaultChannelId === "string" && named.some((channel) => channel.id === value.defaultChannelId) ? value.defaultChannelId : named[0]?.id ?? "";
		const aliases = [...new Set(named.flatMap((channel) => channel.models.map((model) => model.alias)))];
		const defaultModel = typeof value.defaultModel === "string" && aliases.includes(value.defaultModel.trim()) ? value.defaultModel.trim() : "";
		return {
			enabled: value.enabled ?? DEFAULT_ENABLED,
			announceToAgent: value.announceToAgent ?? DEFAULT_ANNOUNCE,
			allowAgentImageGeneration: value.allowAgentImageGeneration ?? DEFAULT_ALLOW_AGENT_IMAGE_GENERATION,
			channels: named.map((channel) => ({
				...channel,
				apiKey: typeof secrets[channel.id] === "string" ? secrets[channel.id] : ""
			})),
			defaultChannelId,
			defaultModel,
			promptApiUrl: typeof value.promptApiUrl === "string" ? value.promptApiUrl.trim() : "",
			promptApiKey: typeof value.promptApiKey === "string" ? value.promptApiKey.trim() : "",
			promptModel: typeof value.promptModel === "string" ? value.promptModel.trim() : "",
			storage: {
				enabled: value.storageEnabled ?? false,
				endpoint: typeof value.storageEndpoint === "string" ? value.storageEndpoint.trim() : "",
				region: typeof value.storageRegion === "string" ? value.storageRegion.trim() : "",
				accessKey: typeof value.storageAccessKey === "string" ? value.storageAccessKey.trim() : "",
				secretKey: typeof value.storageSecretKey === "string" ? value.storageSecretKey.trim() : "",
				prefix: typeof value.storagePrefix === "string" && value.storagePrefix.trim() !== "" ? value.storagePrefix.trim() : "dsh-imagegen",
				syncGallery: value.storageSyncGallery ?? true,
				syncHistory: value.storageSyncHistory ?? false
			},
			skills: {
				enabled: value.skillsEnabled ?? true,
				allowHeavy: value.allowHeavySkills ?? true,
				allowlist: (value.skillAllowlist ?? "").split(/[\n,]/).map((item) => item.trim()).filter((item) => item !== ""),
				outputDir: typeof value.skillOutputDir === "string" ? value.skillOutputDir.trim() : "",
				heavyTimeoutMs: Math.max(0, Math.round((value.skillHeavyTimeoutMinutes ?? 20) * 6e4)),
				agentPreset: typeof value.skillAgentPreset === "string" ? value.skillAgentPreset.trim() : ""
			},
			skillConfig: {
				values: asConfigDict(value.skillConfig),
				secrets: asConfigDict(value.skillConfigSecrets)
			}
		};
	};
	let settingsSeam;
	const channelsView = () => {
		const seam = settingsSeam;
		if (seam !== void 0 && typeof seam.describe === "function") {
			const described = seam.describe({ redactSecrets: false });
			const row = described.find((candidate) => String(candidate.ns) === "imagegen");
			const rawChannels = row?.value?.channels;
			const list = Array.isArray(rawChannels) ? rawChannels : typeof rawChannels?.get === "function" ? rawChannels.get() : [];
			const rawSecrets = row?.value?.channelSecrets;
			const secrets = rawSecrets !== null && typeof rawSecrets === "object" ? typeof rawSecrets.get === "function" ? rawSecrets.get() : rawSecrets : {};
			const channels = normalizeChannels(list).map((channel) => ({
				...channel,
				apiKey: typeof secrets[channel.id] === "string" ? secrets[channel.id] : ""
			}));
			if (channels.length > 0) {
				const wanted = row.value.defaultChannelId;
				return {
					channels,
					defaultChannelId: channels.some((channel) => channel.id === wanted) ? wanted : channels[0].id
				};
			}
		}
		const value = resolve();
		return {
			channels: value.channels,
			defaultChannelId: value.defaultChannelId
		};
	};
	setStorageSyncHandler((kind, filePath) => {
		const storage = resolve().storage;
		if (!storage.enabled || !storage.endpoint.trim() || storage.secretKey.trim() === "") return;
		if (kind === "gallery" && !storage.syncGallery) return;
		if (kind === "history" && !storage.syncHistory) return;
		putObject(storage, `${storage.prefix}/${kind === "gallery" ? "gallery" : "images"}/${path.basename(filePath)}`, readFileSync(filePath), mimeOfPath(filePath)).catch(() => {});
	});
	const subscriptions = new SubscriptionManager(ctx);
	const runtime = new ImageGenerationRuntime(channelsView, void 0, subscriptions);
	const pendingConversationImages = /* @__PURE__ */ new Map();
	setSkillTranslate((key, params, language) => interpolate(key, params, imageGenLanguageOf(language)));
	let skillRunner;
	const resolveSkills = () => resolve().skills;
	skillRunner = new SkillRunner({
		backend: {
			canvas: canvasStore,
			chat: { complete: async (options) => chatComplete(resolvePromptModelConfig(resolve()), options) }
		},
		enabled: () => resolve().enabled && resolveSkills().enabled,
		heavyEnabled: () => resolveSkills().allowHeavy,
		allowlist: () => resolveSkills().allowlist,
		runRoot: () => resolveSkills().outputDir,
		heavyTimeoutMs: () => resolveSkills().heavyTimeoutMs,
		dataRoot: () => imageDataRoot(),
		pptInstallUrl: knownSkillUrl(EDITABLE_PPT_SKILL)
	});
	/** Settings write path, installed by the settings injection further down. */
	let mutateSettings;
	let settingsNamespace = IMAGEGEN_SETTINGS_NAMESPACE;
	/** Entry paths the last library listing resolved, so lookups agree with it. */
	const entryPathByName = /* @__PURE__ */ new Map();
	/** Localize one ignored-declaration reason for the panel. */
	const configIssueText = (language) => (issue) => {
		const t = canvasSkillCopy(language);
		switch (issue) {
			case "unsupported-version": return t("canvas.skills.configIssueVersion");
			case "empty": return t("canvas.skills.configIssueEmpty");
			default: return t("canvas.skills.configIssueUnreadable");
		}
	};
	/** Resolve one skill's values from the live settings dictionaries. */
	const skillValues = (name, declaration) => valuesFor(declaration, resolve().skillConfig, name);
	/**
	* The library entry path for one skill: the last listing's answer when it has
	* one, else a direct disk read — so a config lookup and the panel agree.
	*/
	const entryPathFor = async (name) => {
		const known = entryPathByName.get(name);
		if (known !== void 0) return known;
		return (await readLocalSkill(skillsRoot(), name).catch(() => void 0))?.path;
	};
	/** Look up a declaration by skill name, reading its path from disk. */
	const declarationByName = async (name) => {
		const entryPath = await entryPathFor(name);
		return await readCanvasSkillConfig({
			name,
			...entryPath === void 0 ? {} : { entryPath },
			root: skillsRoot(),
			store: resolve().skillConfig
		});
	};
	/** The directory a `command` step runs in by default (created on demand). */
	const configRunRoot = (name) => {
		const configured = resolveSkills().outputDir.trim();
		const root = configured === "" ? path.join(imageDataRoot(), "canvas", "runs") : configured;
		return path.join(root, "skill-config", name);
	};
	let skillRegistryNames;
	/** One entry's "why the node menu cannot offer this" line, in caller copy. */
	const issueText = (language) => (issue, name) => {
		const t = canvasSkillCopy(language);
		switch (issue) {
			case "no-frontmatter": return t("canvas.skills.libraryIssueFrontmatter");
			case "bad-name": return t("canvas.skills.libraryIssueName", { name });
			case "no-description": return t("canvas.skills.libraryIssueDescription");
			case "bad-invocation": return t("canvas.skills.libraryIssueInvocation");
			default: return t("canvas.skills.libraryIssueUserOnly");
		}
	};
	const snapshotLibrary = async (language) => {
		const library = await listLibrary({
			root: skillsRoot(),
			...skillRegistryNames === void 0 ? {} : { known: skillRegistryNames },
			networkAvailable: true,
			issueText: issueText(language)
		});
		const store = resolve().skillConfig;
		const entries = await Promise.all(library.entries.map(async (entry) => {
			if (entry.path !== void 0) entryPathByName.set(entry.name, entry.path);
			const found = await readCanvasSkillConfig({
				name: entry.name,
				...entry.path === void 0 ? {} : { entryPath: entry.path },
				root: skillsRoot(),
				store,
				issueText: configIssueText(language)
			});
			return found.view === void 0 ? entry : {
				...entry,
				config: found.view
			};
		}));
		return {
			...library,
			entries
		};
	};
	/** Merge one save request into both dictionaries and write them back. */
	const saveSkillValues = async (name, declaration, edits) => {
		if (mutateSettings === void 0) throw new SkillStoreError(canvasSkillCopy()("canvas.skills.configUnwritable"));
		const store = resolve().skillConfig;
		const next = {
			values: { ...store.values },
			secrets: { ...store.secrets }
		};
		const byId = new Map(declaration.manifest.fields.map((field) => [field.id, field]));
		for (const edit of edits) {
			const field = byId.get(edit.id);
			if (field === void 0) continue;
			const key = skillConfigKey(name, field.id);
			const dict = field.type === "secret" ? next.secrets : next.values;
			if (edit.value.trim() === "") delete dict[key];
			else dict[key] = edit.value;
		}
		await mutateSettings([{
			op: "set",
			path: ["skillConfig"],
			value: next.values
		}, {
			op: "set",
			path: ["skillConfigSecrets"],
			value: next.secrets
		}]);
	};
	const skillLibrary = {
		list: async (options) => await snapshotLibrary(options?.language),
		install: async (request) => {
			const root = skillsRoot();
			const installed = [];
			const failed = [];
			let message;
			if (request.asset !== void 0) try {
				const blob = (await canvasStore.readAssets([request.asset])).get(request.asset.assetId);
				if (blob === void 0) throw new SkillStoreError("上传的压缩包已失效，请重新上传");
				installed.push(await installFromArchive(blob.data, root, request.name ?? "skill", request.force === true));
			} catch (error) {
				message = messageOf(error);
			}
			for (const source of request.sources ?? []) try {
				installed.push(await installFromUrl(source, root, {
					force: request.force === true,
					fallbackName: request.name
				}));
			} catch (error) {
				failed.push({
					source,
					message: messageOf(error)
				});
			}
			return {
				ok: installed.length > 0,
				installed,
				failed,
				library: await snapshotLibrary(request.language),
				...message === void 0 ? {} : { message }
			};
		},
		remove: async (name, options) => {
			try {
				const removed = await removeSkill(name, skillsRoot());
				return {
					ok: true,
					library: await snapshotLibrary(options?.language),
					message: removed
				};
			} catch (error) {
				return {
					ok: false,
					library: await snapshotLibrary(options?.language),
					message: messageOf(error)
				};
			}
		},
		configSave: async (request) => {
			try {
				const found = await declarationByName(request.name);
				if (found.declaration === void 0) throw new SkillStoreError(configIssueText(request.language)(found.issue ?? "empty"));
				await saveSkillValues(request.name, found.declaration, request.values ?? []);
				return {
					ok: true,
					library: await snapshotLibrary(request.language)
				};
			} catch (error) {
				return {
					ok: false,
					library: await snapshotLibrary(request.language),
					message: messageOf(error)
				};
			}
		},
		configApply: async (request) => {
			const library = async () => await snapshotLibrary(request.language);
			try {
				const found = await declarationByName(request.name);
				if (found.declaration === void 0) throw new SkillStoreError(configIssueText(request.language)(found.issue ?? "empty"));
				const values = skillValues(request.name, found.declaration);
				const runRoot = configRunRoot(request.name);
				await mkdir(runRoot, { recursive: true });
				const skillDir = bundleDirOf((await readLocalSkill(skillsRoot(), request.name).catch(() => void 0))?.path);
				const results = await applySkillConfigSteps(found.declaration, values, {
					runRoot,
					...skillDir === void 0 ? {} : { skillDir }
				});
				return {
					ok: results.every((result) => result.ok),
					library: await library(),
					steps: results.map((result) => ({
						kind: result.step.kind,
						detail: result.detail,
						ok: result.ok,
						...result.output === void 0 ? {} : { output: result.output }
					}))
				};
			} catch (error) {
				return {
					ok: false,
					library: await library(),
					steps: [],
					message: messageOf(error)
				};
			}
		}
	};
	ctx.inject(["skills", "agents"], (sctx) => {
		const services = sctx;
		sctx.effect(() => {
			const registry = createSkillRegistryBackend(services.skills, { root: skillsRoot });
			registry.list().then((listed) => {
				skillRegistryNames = listed.map((item) => ({
					name: item.name,
					...item.path === void 0 ? {} : { path: item.path }
				}));
			}, () => {
				skillRegistryNames = [];
			});
			const presets = sctx.get("agentPresets");
			const defaultModel = sctx.get("agentDefaultModel");
			skillRunner?.attach({
				registry,
				agents: {
					available: () => services.agents !== void 0,
					create: async (options) => await createCanvasSkillAgent({
						agents: services.agents,
						...presets === void 0 ? {} : { presets },
						...defaultModel === void 0 ? {} : { defaultModel },
						agentPreset: resolveSkills().agentPreset,
						sessionId: options.sessionId,
						cwd: options.cwd,
						systemPrompt: options.systemPrompt,
						...options.signal === void 0 ? {} : { signal: options.signal },
						fail: options.fail
					})
				},
				skillConfig: {
					missing: async (names) => {
						const out = /* @__PURE__ */ new Map();
						for (const name of names) {
							const found = await declarationByName(name);
							if (found.declaration === void 0) continue;
							const missing = missingFields(found.declaration, skillValues(name, found.declaration));
							if (missing.length > 0) out.set(name, missing);
						}
						return out;
					},
					note: async (name) => {
						const found = await declarationByName(name);
						if (found.declaration === void 0) return void 0;
						return configNote(found.declaration, skillValues(name, found.declaration));
					}
				}
			});
			return () => {
				skillRunner?.attach({});
			};
		}, "dsh-imagegen: canvas skills");
	});
	ctx.inject(["settings", "attachments"], (sctx) => {
		const seam = sctx.get("settings");
		settingsSeam = seam;
		settingsNamespace = resolveSettingsNamespaceCompat(ctx, seam, ImageGenSettingsNamespace);
		const saved = current;
		current = () => {
			const described = seam.describe({ redactSecrets: false });
			const row = described.find((candidate) => String(candidate.ns) === "imagegen") ?? described.find((candidate) => String(candidate.ns) === settingsNamespace);
			const value = row?.value;
			if (value !== void 0 && Array.isArray(value.channels) && value.channels.length > 0) return value;
			return saved();
		};
		mutateSettings = async (ops) => {
			await seam.mutate(settingsNamespace, ops);
		};
		sctx.effect(() => {
			const disposers = makeRoutes({
				settings: seam,
				settingsNamespace,
				resolve: () => {
					const value = resolve();
					const channel = value.channels.find((candidate) => candidate.id === value.defaultChannelId) ?? value.channels[0];
					return {
						apiUrl: channel?.apiUrl ?? "",
						apiKey: channel?.apiKey ?? ""
					};
				},
				resolveChannels: channelsView,
				resolvePrompt: () => resolvePromptModelConfig(resolve()),
				resolveImageModels: () => {
					const value = resolve();
					return [...new Set(value.channels.flatMap((channel) => channel.models.map((model) => model.alias)))];
				},
				attachments: sctx.attachments,
				pendingConversationImages,
				runtime,
				subscriptions,
				resolveStorage: () => resolve().storage,
				skills: skillRunner,
				skillLibrary
			}).map((route) => ctx.webServer.register(route));
			const TEMPLATE_SYNC_INITIAL_DELAY_MS = 3e4;
			const TEMPLATE_SYNC_INTERVAL_MS = 720 * 60 * 1e3;
			let syncTimer;
			const runSync = () => {
				if (!resolve().enabled) return;
				syncAllTemplates().catch(() => {});
			};
			const startTimer = setTimeout(runSync, TEMPLATE_SYNC_INITIAL_DELAY_MS);
			syncTimer = setInterval(runSync, TEMPLATE_SYNC_INTERVAL_MS);
			syncTimer.unref?.();
			return () => {
				clearTimeout(startTimer);
				clearInterval(syncTimer);
				for (const dispose of disposers) dispose();
			};
		}, "dsh-imagegen: routes");
	});
	ctx.inject([
		"tools",
		"attachments",
		"commands"
	], (tctx) => {
		tctx.effect(() => {
			const resolveAgentConfig = () => {
				const value = resolve();
				return {
					enabled: value.enabled,
					allowAgentImageGeneration: value.allowAgentImageGeneration,
					channels: value.channels,
					defaultChannelId: value.defaultChannelId,
					defaultModel: value.defaultModel
				};
			};
			const disposeTools = registerAgentImageTools(tctx, runtime, resolveAgentConfig);
			const disposeCommand = registerEditImageCommand(tctx, runtime, resolveAgentConfig, {
				get: (sessionId) => pendingConversationImages.get(sessionId),
				consume: (sessionId, ref) => {
					if (pendingConversationImages.get(sessionId)?.attachmentId === ref.attachmentId) pendingConversationImages.delete(sessionId);
				}
			});
			return () => {
				disposeCommand();
				disposeTools();
			};
		}, "dsh-imagegen: agent image tools and commands");
	});
	let disposeSection;
	const sync = () => {
		if (disposeSection !== void 0) {
			disposeSection();
			disposeSection = void 0;
		}
		const value = resolve();
		if (!value.enabled || !value.announceToAgent) return;
		disposeSection = ctx.systemPrompt.section({
			name: "plugin:dsh-imagegen",
			order: SECTION_ORDER,
			text: guidanceFor(value.channels, value.defaultChannelId, value.defaultModel)
		});
	};
	installSettingsSectionCompat(ctx, ImageGenSettingsNamespace, Config, unwrapConfig(config), {
		setSource: (source) => {
			current = source;
			sync();
		},
		onChange: sync
	});
	sync();
	return () => {
		setStorageSyncHandler(void 0);
	};
}
//#endregion
export { CURRENT_VERSION, Config, DIAGNOSTIC_MAX, EDITABLE_PPT_SKILL, IMAGEGEN_GUIDANCE, ImageGenError, ImageGenSettingsNamespace, ImageGenerationRuntime, KNOWN_SKILL_SOURCES, MAX_CANVAS_FILE_BYTES, MAX_EXTRACTED_CHARS, MAX_LAYER_IMAGE_BYTES, MAX_PREVIEW_CHARS, MAX_SKILL_ARCHIVE_BYTES, SkillRunner, SkillStoreError, SubscriptionManager, addTemplateFavorite, analyzeLayers, appendGallery, apply, applySkillConfigSteps, buildFilePreview, builtinCanvasSkills, canvasSkillCatalog, canvasSkillCopy, canvasStore, checkForUpdate, classifySource, clearDiagnostics, clearGallery, clearTemplateFavoritesMemo, clearTemplateMemo, clearUpdateCache, compareVersions, configNote, configView, createCanvasSkillAgent, createSkillRegistryBackend, extractFileText, fileKindOf, findCanvasSkill, generateImage, inject, inspectSkillMarkdown, installFromArchive, installFromUrl, installUpdate, installableSkillName, isBlockedFileName, isDshSkillName, isEditablePptSkill, isValidSkillName, isZipDirectory, knownSkillUrl, latestSessionImage, listDiagnostics, listGallery, listLibrary, listLocalSkills, listTemplateFavorites, listTemplates, makeRoutes, mergeExternalSkills, mimeFromFileName, missingFields, name, networkErrorFields, normalizeLayerPlan, parseSkillConfigManifest, parseSkillFrontmatter, profileFromProcess, promptCharLimit, putObject, readCanvasSkillConfig, readGalleryImage, readLocalSkill, readSkillConfigFile, readTemplateImage, readZipDirectory, readZipEntry, recipeFor, recipeNames, recordDiagnostic, redactDiagnosticText, refreshTemplates, registerAgentImageTools, registerEditImageCommand, removeGallery, removeSkill, removeTemplateFavorite, resolveAgentImageModel, resolveConfigTarget, resolvePromptModelConfig, safeFileName, sampleTemplates, setSkillLanguage, setSkillTranslate, setStorageSyncHandler, skillConfigKey, skillsRoot, subscriptionOauthRef, syncAllTemplates, testStorage, tierOfExternalSkill, updateGalleryTags, valuesFor, vendorOf };
