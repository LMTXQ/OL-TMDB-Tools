  (() => {
    "use strict";

    if (window.__OPENLIST_TMDB_MATCHER__) return;
    window.__OPENLIST_TMDB_MATCHER__ = true;

    const STORAGE = {
      key: "openlist_tmdb_api_key",
      language: "openlist_tmdb_language",
      mode: "openlist_tmdb_mode",
      rename: "openlist_tmdb_rename",
      structuring: "openlist_tmdb_structuring",
      concurrency: "openlist_tmdb_concurrency",
    };
    const DEFAULT_TMDB_API_KEY = document.currentScript?.dataset?.tmdbApiKey || "";
    const REQUEST_TIMEOUTS = {
      tmdb: 12_000,
      image: 30_000,
      openListRead: 20_000,
      openListWrite: 60_000,
    };
    const TMDB_RETRY_STATUSES = new Set([429, 502, 503, 504]);
    const TMDB_MAX_RETRIES = 2;
    const TMDB_MAX_CONCURRENCY = 5;
    const TMDB_CONCURRENCY_OPTIONS = new Set([1, 3, 5]);
    const savedTmdbConcurrency = Number(localStorage.getItem(STORAGE.concurrency));
    const initialTmdbConcurrency = TMDB_CONCURRENCY_OPTIONS.has(savedTmdbConcurrency)
      ? savedTmdbConcurrency
      : TMDB_MAX_CONCURRENCY;
    const VIDEO_EXTS = new Set([
      "mkv",
      "mp4",
      "avi",
      "mov",
      "wmv",
      "flv",
      "ts",
      "m2ts",
      "webm",
      "rmvb",
      "iso",
      "m4v",
      "mpg",
      "mpeg",
    ]);
    const SUBTITLE_EXTS = new Set([
      "srt",
      "ass",
      "ssa",
      "sub",
      "vtt",
      "sup",
      "idx",
    ]);

    const state = {
      entries: [],
      files: [],
      selectedName: "",
      selectedNames: [],
      results: [],
      selectedItem: null,
      selectedEpisode: null,
      tvBatchRows: [],
      cleanupRows: [],
      cleanupGenerated: false,
      metadataReport: null,
      duplicateReport: null,
      executionReport: null,
      compatibilityWarnings: [],
      mode: "movie",
      currentPath: "/",
      write: false,
      writeContentBypass: false,
      userPermission: null,
      permissionLoaded: false,
      permissionToken: null,
      loading: false,
      directoryLoadId: 0,
      tmdbConcurrencyLimit: initialTmdbConcurrency,
      tmdbConcurrency: initialTmdbConcurrency,
      tmdbRateLimited: false,
    };
    const tmdbSessionCache = new Map();
    const tmdbInflightRequests = new Map();

    const $ = (selector, root = document) => root.querySelector(selector);

    const addCompatibilityWarning = (code, message) => {
      if (state.compatibilityWarnings.some((warning) => warning.code === code)) return;
      state.compatibilityWarnings.push({ code, message });
      renderCompatibilityWarnings();
    };

    const removeCompatibilityWarning = (code) => {
      const next = state.compatibilityWarnings.filter((warning) => warning.code !== code);
      if (next.length === state.compatibilityWarnings.length) return;
      state.compatibilityWarnings = next;
      renderCompatibilityWarnings();
    };

    const inspectRuntimeCompatibility = () => {
      const config = window.OPENLIST_CONFIG;
      if (!config || typeof config !== "object") {
        addCompatibilityWarning("config-missing", "未检测到 window.OPENLIST_CONFIG，正在使用同源默认配置。");
        return;
      }
      if (config.base_path !== undefined && typeof config.base_path !== "string") {
        addCompatibilityWarning("base-path-type", "OPENLIST_CONFIG.base_path 格式异常，已忽略该值。");
      }
      if (config.api !== undefined && typeof config.api !== "string") {
        addCompatibilityWarning("api-type", "OPENLIST_CONFIG.api 格式异常，已改用当前站点地址。");
      }
    };

    const escapeXml = (value) =>
      String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&apos;");

    const escapeHtml = (value) =>
      String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");

    const trimSlashes = (value) => String(value || "").replace(/\/+$/, "");

    const basePath = () => {
      const raw = window.OPENLIST_CONFIG?.base_path || "";
      if (typeof raw !== "string") return "";
      if (!raw || raw === "/") return "";
      return raw.startsWith("/") ? trimSlashes(raw) : `/${trimSlashes(raw)}`;
    };

    const apiBase = () => {
      const configured = window.OPENLIST_CONFIG?.api;
      if (typeof configured === "string" && configured) return trimSlashes(configured);
      return `${location.origin}${basePath()}`;
    };

    const currentOpenListPath = () => {
      const base = basePath();
      let pathname = decodeURIComponent(location.pathname);
      if (base && pathname.startsWith(base)) pathname = pathname.slice(base.length) || "/";
      if (!pathname.startsWith("/")) pathname = `/${pathname}`;
      return pathname || "/";
    };

    const joinPath = (dir, name) => {
      const cleanDir = dir && dir !== "/" ? dir.replace(/\/+$/, "") : "";
      return `${cleanDir}/${name}`.replace(/\/+/g, "/");
    };

    const extname = (name) => {
      const index = name.lastIndexOf(".");
      return index > 0 ? name.slice(index + 1).toLowerCase() : "";
    };

    const basename = (name) => {
      const index = name.lastIndexOf(".");
      return index > 0 ? name.slice(0, index) : name;
    };

    const isVideo = (obj) => !obj.is_dir && VIDEO_EXTS.has(extname(obj.name));

    const isSubtitle = (obj) => !obj.is_dir && SUBTITLE_EXTS.has(extname(obj.name));

    const findSubtitleFilesFor = (videoName) => {
      const videoBase = normalizeName(basename(videoName));
      if (!videoBase) return [];
      return state.entries.filter((entry) => {
        if (entry.is_dir || !SUBTITLE_EXTS.has(extname(entry.name))) return false;
        const subBase = normalizeName(basename(entry.name));
        return subBase === videoBase || subBase.startsWith(`${videoBase}.`);
      });
    };

    const normalizeName = (name) => String(name || "").toLowerCase();

    const standardEpisodePattern = /\bS\d{2}E\d{2,3}\b/i;

    const parseMovieName = (name) => {
      const base = basename(name);
      const yearMatch = base.match(/(?:^|[.\s_\-[({])((?:19|20)\d{2})(?:$|[.\s_\-\])}])/);
      const year = yearMatch ? yearMatch[1] : "";
      const beforeYear = yearMatch ? base.slice(0, yearMatch.index) : base;
      const title = beforeYear
        .replace(/\[[^\]]*]/g, " ")
        .replace(/\([^)]*$/g, " ")
        .replace(/[._]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      return { title: title || base.replace(/[._]+/g, " ").trim(), year };
    };

    const parseEpisodeName = (name) => {
      const base = basename(name);
      const patterns = [
        /\bS(\d{1,2})\s*E(\d{1,3})\b/i,
        /\b(\d{1,2})x(\d{1,3})\b/i,
        /第\s*(\d{1,3})\s*[集话話]/i,
        /\bEP?\s*(\d{1,3})\b/i,
      ];
      for (const pattern of patterns) {
        const match = base.match(pattern);
        if (!match) continue;
        const season = match.length > 2 ? Number(match[1]) : 1;
        const episode = Number(match.length > 2 ? match[2] : match[1]);
        const title = base
          .slice(0, match.index)
          .replace(/\[[^\]]*]/g, " ")
          .replace(/[._-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return {
          season: Number.isFinite(season) && season > 0 ? season : 1,
          episode,
          title,
        };
      }
      return null;
    };

    const CLEANUP_TECHNICAL_PATTERN = /\b(?:4320p|2160p|1080p|720p|4k|8k|web[ ._-]?dl|webrip|bluray|bdrip|brrip|hdrip|hdtv|remux|x26[45]|h[ .]?26[45]|hevc|avc|av1|10bit|12bit|hdr10\+?|hdr|dolby[ ._-]?vision|dv|aac(?:[ .]?\d[ .]\d)?|ddp?(?:[ .]?\d[ .]\d)?|dts(?:[ ._-]?hd)?|truehd|atmos|flac|ac3)\b/gi;
    const CLEANUP_AD_PATTERN = /(?:更多(?:高清)?资源|关注(?:微信公众号|公众号)|扫码(?:关注|下载)?|加入?\s*(?:qq|q)?群|网盘资源|本站(?:专用|发布))/gi;
    const CLEANUP_DOMAIN_PATTERN = /\b(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:com|cn|net|org)\b/gi;
    const CLEANUP_BRACKET_AD_PATTERN = /(?:www\.|https?:|\.(?:com|cn|net|org)\b|公众号|字幕组|压制组|发布组|资源|广告|网盘|qq\s*群|q群|微信|扫码|更多)/i;
    const containsCleanupTechnicalTag = (value) => {
      CLEANUP_TECHNICAL_PATTERN.lastIndex = 0;
      const matches = CLEANUP_TECHNICAL_PATTERN.test(value);
      CLEANUP_TECHNICAL_PATTERN.lastIndex = 0;
      return matches;
    };

    const cleanupRuleOptions = () => ({
      ads: Boolean($(".ol-tmdb-cleanup-ads")?.checked),
      brackets: Boolean($(".ol-tmdb-cleanup-brackets")?.checked),
      technical: Boolean($(".ol-tmdb-cleanup-technical")?.checked),
    });

    const cleanupFilename = (name, options = cleanupRuleOptions()) => {
      const extension = extname(name);
      const originalBase = basename(name);
      let cleaned = originalBase;
      const rules = [];
      const apply = (label, transform) => {
        const next = transform(cleaned);
        if (next !== cleaned) {
          cleaned = next;
          rules.push(label);
        }
      };

      if (options.ads) {
        apply("资源站 / 广告词", (value) =>
          value
            .replace(/\[([^\]]*)]/g, (match, content) => CLEANUP_BRACKET_AD_PATTERN.test(content) ? " " : match)
            .replace(/【([^】]*)】/g, (match, content) => CLEANUP_BRACKET_AD_PATTERN.test(content) ? " " : match)
            .replace(CLEANUP_AD_PATTERN, " ")
            .replace(CLEANUP_DOMAIN_PATTERN, " ")
        );
      }
      if (options.brackets) {
        apply("无关括号", (value) =>
          value
            .replace(/\[([^\]]*)]|【([^】]*)】|\{([^}]*)}/g, (match, square, wide, curly) => {
              const content = String(square ?? wide ?? curly ?? "").trim();
              return /^(?:(?:19|20)\d{2}|s\d{1,2}e\d{1,3}|\d{1,2}x\d{1,3})$/i.test(content)
                ? match
                : " ";
            })
            .replace(/\(([^)]*)\)/g, (match, content) =>
              CLEANUP_BRACKET_AD_PATTERN.test(content) || containsCleanupTechnicalTag(content)
                ? " "
                : match
            )
        );
      }
      if (options.technical) {
        apply("技术标签", (value) => value.replace(CLEANUP_TECHNICAL_PATTERN, " "));
      }

      if (!rules.length) return { name, rules: [] };
      cleaned = cleaned
        .replace(/(?:\s*[._-]\s*){2,}/g, " ")
        .replace(/\s{2,}/g, " ")
        .replace(/^[\s._-]+|[\s._-]+$/g, "")
        .trim();
      if (!cleaned || cleaned === originalBase) return { name, rules: [] };
      return { name: `${cleaned}.${extension}`, rules };
    };

    const generateCleanupRows = (options = cleanupRuleOptions()) => {
      const previous = new Map(state.cleanupRows.map((row) => [row.sourceName, row]));
      state.cleanupRows = state.files.flatMap((file) => {
        const cleaned = cleanupFilename(file.name, options);
        if (cleaned.name === file.name) return [];
        const prior = previous.get(file.name);
        return [{
          sourceName: file.name,
          targetName: cleaned.name,
          rules: cleaned.rules,
          selected: prior?.targetName === cleaned.name ? prior.selected : true,
          result: "",
        }];
      });
      state.cleanupGenerated = true;
      return state.cleanupRows;
    };

    const currentDirectoryTitle = () => {
      const parts = state.currentPath.split("/").filter(Boolean);
      const last = parts.at(-1) || "";
      const parent = parts.at(-2) || last;
      const candidate = /^(season|s)\s*\d+|第\s*\d+\s*季$/i.test(last) ? parent : last;
      return candidate.replace(/[._-]+/g, " ").trim();
    };

    const inferMode = (files) => {
      const episodeCount = files.filter((file) => parseEpisodeName(file.name)).length;
      const pathLooksTv = /(?:^|\/)(season\s*\d+|s\d{1,2}|第\s*\d+\s*季)(?:\/|$)/i.test(state.currentPath);
      return episodeCount >= Math.max(1, Math.ceil(files.length * 0.4)) || pathLooksTv ? "tv" : "movie";
    };

    const safeFilePart = (value) =>
      String(value || "")
        .replace(/[\\/:*?"<>|]/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const itemYear = (item) =>
      (item?.release_date || item?.first_air_date || "").slice(0, 4);

    const itemDisplayTitle = (item) =>
      item?.title || item?.name || item?.original_title || item?.original_name || "";

    const positiveNumber = (value) => {
      const number = Number(value);
      return Number.isInteger(number) && number > 0 ? number : 0;
    };

    const tvEpisodeCode = (season, episode) =>
      `S${String(season || 1).padStart(2, "0")}E${String(episode || 0).padStart(2, "0")}`;

    const tvEpisodeBaseName = (show, episode, season, episodeNumber) => {
      const title = safeFilePart(itemDisplayTitle(show));
      const episodeTitle = safeFilePart(episode?.name || "");
      const code = tvEpisodeCode(season, episodeNumber);
      return episodeTitle ? `${title} - ${code} - ${episodeTitle}` : `${title} - ${code}`;
    };

    const targetBaseName = () => {
      if (!state.selectedItem) return "";
      const title = safeFilePart(itemDisplayTitle(state.selectedItem));
      const year = itemYear(state.selectedItem);
      if (state.mode === "tv") {
        const season = positiveNumber($(".ol-tmdb-season")?.value) || 1;
        const episode = positiveNumber($(".ol-tmdb-episode")?.value);
        return tvEpisodeBaseName(state.selectedItem, state.selectedEpisode, season, episode);
      }
      return year ? `${title} (${year})` : title;
    };

    const targetVideoName = () => {
      const file = selectedFile();
      if (!file || !state.selectedItem) return "";
      return `${targetBaseName()}.${extname(file.name)}`;
    };

    const structuringShowDir = () => {
      if (!state.selectedItem) return "";
      const title = safeFilePart(itemDisplayTitle(state.selectedItem));
      const year = itemYear(state.selectedItem);
      const dirName = year ? `${title} (${year})` : title;
      return joinPath(state.currentPath, dirName);
    };

    const structuringTargetDir = () => {
      const showDir = structuringShowDir();
      if (!showDir) return "";
      if (state.mode === "tv") {
        const season = positiveNumber($(".ol-tmdb-season")?.value) || 1;
        return joinPath(showDir, `Season ${String(season).padStart(2, "0")}`);
      }
      return showDir;
    };

    const structuringSeasonDir = (season) => {
      const showDir = structuringShowDir();
      if (!showDir) return "";
      return joinPath(showDir, `Season ${String(season || 1).padStart(2, "0")}`);
    };

    const subtitleTargetName = (originalVideoName, targetVideoName, subtitleName) => {
      const originalVideoBase = basename(originalVideoName);
      const targetVideoBase = basename(targetVideoName);
      const subExt = extname(subtitleName);
      const subBase = basename(subtitleName);
      const subBaseLower = normalizeName(subBase);
      const videoBaseLower = normalizeName(originalVideoBase);
      if (originalVideoBase === targetVideoBase) return subtitleName;
      if (subBaseLower === videoBaseLower) return `${targetVideoBase}.${subExt}`;
      if (subBaseLower.startsWith(`${videoBaseLower}.`)) {
        const suffix = subBase.slice(originalVideoBase.length);
        return `${targetVideoBase}${suffix}.${subExt}`;
      }
      return `${targetVideoBase}.${subExt}`;
    };

    const selectedFile = () =>
      state.files.find((file) => file.name === state.selectedName) ||
      state.files.find((file) => file.name === state.selectedNames[0]);

    const isTvBatchActive = () => state.mode === "tv" && state.selectedNames.length > 1;

    const resetDirectoryState = (path = currentOpenListPath()) => {
      state.directoryLoadId += 1;
      state.currentPath = path;
      state.entries = [];
      state.files = [];
      state.selectedName = "";
      state.selectedNames = [];
      state.results = [];
      state.selectedItem = null;
      state.selectedEpisode = null;
      state.tvBatchRows = [];
      state.cleanupRows = [];
      state.cleanupGenerated = false;
      state.metadataReport = null;
      state.duplicateReport = null;
      state.executionReport = null;
      state.write = false;
      state.writeContentBypass = false;
    };

    const ensureLoadedDirectory = () => {
      const path = currentOpenListPath();
      if (path === state.currentPath) return true;
      resetDirectoryState(path);
      render();
      setStatus("目录已切换，正在重新读取文件列表", "error");
      withStatus(loadFiles);
      return false;
    };

    const userCan = (bit) =>
      Number.isInteger(state.userPermission) && ((state.userPermission >> bit) & 1) === 1;

    const operationCapabilities = () => {
      const permissionKnown = Number.isInteger(state.userPermission);
      const directoryWrite = state.write;
      const canWrite = directoryWrite && (!permissionKnown || userCan(4));
      return {
        permissionKnown,
        directoryWrite,
        rename: canWrite,
        structuring: canWrite,
        renameReason: !directoryWrite
          ? "当前目录不允许该用户写入"
          : permissionKnown && !userCan(4)
            ? "当前用户缺少 rename 权限"
            : "",
      };
    };

    const actionOptions = () => {
      const capabilities = operationCapabilities();
      return {
        rename: capabilities.rename && Boolean($(".ol-tmdb-do-rename")?.checked),
        structuring: capabilities.structuring && Boolean($(".ol-tmdb-do-structuring")?.checked),
      };
    };

    const noAvailableActionMessage = () => {
      const capabilities = operationCapabilities();
      return !capabilities.rename && !capabilities.structuring
        ? "当前权限仅允许只读操作；仍可搜索、预览和检查元数据"
        : "请至少选择一个当前可用的操作";
    };

    const findEntry = (name, ignoreName = "") => {
      const normalized = normalizeName(name);
      return state.entries.find((entry) =>
        normalizeName(entry.name) === normalized && entry.name !== ignoreName,
      ) || null;
    };

    const planStep = (id, type, label, name, status, text, extra = {}) => ({
      id,
      type,
      label,
      name,
      status,
      text,
      run: status === "new" || status === "rename" || status === "overwrite" || status === "retry",
      blocking: status === "conflict" || status === "pending",
      ...extra,
    });

    const renamePlanStep = (id, sourceName, targetName, enabled) => {
      if (!enabled) return planStep(id, "rename", "视频", targetName, "disabled", "未选择");
      if (!targetName) return planStep(id, "rename", "视频", targetName, "pending", "待生成目标");
      if (sourceName === targetName) {
        return planStep(id, "rename", "视频", targetName, "unchanged", "无需变更");
      }
      const existing = findEntry(targetName, sourceName);
      if (existing) {
        return planStep(id, "rename", "视频", targetName, "conflict", existing.is_dir ? "与目录冲突" : "目标已存在");
      }
      return planStep(id, "rename", "视频", targetName, "rename", "改名");
    };

    const mkdirPlanStep = (id, dirPath, enabled) => {
      if (!enabled) return planStep(id, "mkdir", "目录", dirPath, "disabled", "未选择");
      if (!dirPath) return planStep(id, "mkdir", "目录", dirPath, "pending", "待生成路径");
      const relativePath = dirPath.startsWith(state.currentPath + "/")
        ? dirPath.slice(state.currentPath.length + 1)
        : dirPath;
      const components = relativePath.split("/").filter(Boolean);
      const firstComponent = components[0];
      if (firstComponent) {
        const existing = findEntry(firstComponent);
        if (existing && !existing.is_dir) {
          return planStep(id, "mkdir", "目录", dirPath, "conflict", "与文件冲突");
        }
        if (existing && existing.is_dir && components.length === 1) {
          return planStep(id, "mkdir", "目录", dirPath, "skip", "已存在");
        }
      }
      return planStep(id, "mkdir", "目录", dirPath, "new", "创建");
    };

    const movePlanStep = (id, fileName, targetDir, enabled) => {
      if (!enabled) return planStep(id, "move", "移动", fileName, "disabled", "未选择");
      if (!fileName) return planStep(id, "move", "移动", fileName, "pending", "待生成目标");
      if (!targetDir) return planStep(id, "move", "移动", fileName, "pending", "待生成目录");
      return planStep(id, "move", "移动", fileName, "new", "移动", { targetDir });
    };

    const conflictingPlanStep = (step, text = "目标重复") => ({
      ...step,
      status: "conflict",
      text,
      run: false,
      blocking: true,
    });

    const stepKind = (step) => {
      if (step.status === "conflict" || step.status === "pending") return "error";
      if (step.status === "overwrite" || step.status === "retry") return "warn";
      if (step.status === "new" || step.status === "rename") return "ok";
      return "";
    };

    const renderPlanStep = (step) => `
      <span class="ol-tmdb-plan-step" data-kind="${stepKind(step)}" title="${escapeHtml(step.name || "")}">
        ${escapeHtml(step.label)}：${escapeHtml(step.text)}
      </span>`;

    const finalizeExecutionPlan = (plan) => {
      const steps = plan.steps || [];
      const counts = {
        create: steps.filter((step) => ["new", "rename", "retry"].includes(step.status)).length,
        overwrite: steps.filter((step) => step.status === "overwrite").length,
        skip: steps.filter((step) => ["skip", "unchanged", "unavailable"].includes(step.status)).length,
        conflict: steps.filter((step) => step.blocking).length,
      };
      return {
        ...plan,
        counts,
        blocking: steps.filter((step) => step.blocking),
      };
    };

    const renderPlanSummary = (plan) => `
      <div class="ol-tmdb-plan-summary" data-kind="${plan.counts.conflict ? "error" : plan.counts.overwrite ? "warn" : ""}">
        <strong>执行计划</strong>
        <span>新建 / 改名 / 移动 ${plan.counts.create}</span>
        <span>覆盖 ${plan.counts.overwrite}</span>
        <span>跳过 / 不变 ${plan.counts.skip}</span>
        <span>冲突 ${plan.counts.conflict}</span>
      </div>`;

    const beginExecutionReport = (plan) => {
      const sourceByStep = new Map();
      plan.rows.forEach((rowPlan) => {
        rowPlan.steps.forEach((step) => sourceByStep.set(step.id, rowPlan.sourceName));
      });
      const report = {
        startedAt: new Date(),
        entries: plan.steps
          .filter((step) => step.status !== "disabled")
          .map((step) => ({
            id: step.id,
            file: sourceByStep.get(step.id) || state.currentPath,
            type: step.type,
            step: step.label,
            target: step.name,
            plannedStatus: step.status,
            status: step.run ? "pending" : "skipped",
            error: "",
          })),
      };
      state.executionReport = report;
      renderExecutionReport();
      return report;
    };

    const updateExecutionReport = (report, step, status, error = "") => {
      if (!report || !step) return;
      const entry = report.entries.find((item) => item.id === step.id);
      if (!entry) return;
      entry.status = status;
      entry.error = error;
      renderExecutionReport();
    };

    const executionReportSummary = (report) => ({
      success: report.entries.filter((entry) => entry.status === "success").length,
      failed: report.entries.filter((entry) => entry.status === "failed").length,
      skipped: report.entries.filter((entry) => entry.status === "skipped" || entry.status === "not-run").length,
      overwrite: report.entries.filter((entry) => entry.plannedStatus === "overwrite" && entry.status === "success").length,
    });

    const finishExecutionReport = (report) => {
      if (!report) return null;
      report.entries.forEach((entry) => {
        if (entry.status === "pending") entry.status = "not-run";
      });
      report.finishedAt = new Date();
      report.summary = executionReportSummary(report);
      renderExecutionReport();
      return report.summary;
    };

    const executionReportText = (report) => {
      if (!report) return "";
      const summary = report.summary || executionReportSummary(report);
      const lines = [
        `OpenList TMDB 执行报告`,
        `目录：${state.currentPath}`,
        `成功：${summary.success}，失败：${summary.failed}，跳过 / 未执行：${summary.skipped}，覆盖：${summary.overwrite}`,
      ];
      report.entries
        .filter((entry) => entry.status === "failed")
        .forEach((entry) => {
          lines.push(`${entry.file} | ${entry.step} | ${entry.target} | ${entry.error}`);
        });
      return lines.join("\n");
    };

    const copyExecutionReport = async () => {
      const text = executionReportText(state.executionReport);
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        setStatus("失败明细已复制", "ok");
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        textarea.remove();
        setStatus("失败明细已复制", "ok");
      }
    };

    const setOperationSelection = (types) => {
      const mappings = [
        ["rename", ".ol-tmdb-do-rename", STORAGE.rename],
        ["structuring", ".ol-tmdb-do-structuring", STORAGE.structuring],
      ];
      mappings.forEach(([type, selector, storageKey]) => {
        const input = $(selector);
        if (!input) return;
        input.checked = types.has(type);
        localStorage.setItem(storageKey, input.checked ? "true" : "false");
      });
      updatePermissionControls();
      renderPreview();
    };

    const prepareFailedRetry = () => {
      const failedEntries = state.executionReport?.entries.filter((entry) =>
        entry.status === "failed" || entry.status === "not-run"
      ) || [];
      const types = new Set();
      failedEntries.forEach((entry) => {
        if (entry.type === "rename") types.add("rename");
        if (entry.type === "mkdir" || entry.type === "move") types.add("structuring");
      });
      if (!types.size) {
        setStatus("报告中没有可恢复的失败或未执行写入步骤", "error");
        return;
      }
      setOperationSelection(types);
      const labels = [...types].map((type) => type === "rename" ? "改名" : "结构化");
      setStatus(`已仅选择失败 / 未执行步骤类型：${labels.join("、")}；请核对执行计划后再次执行`, "ok");
    };

    function renderExecutionReport() {
      const node = $(".ol-tmdb-execution-report");
      if (!node) return;
      const report = state.executionReport;
      if (!report) {
        node.innerHTML = "";
        return;
      }
      const summary = report.summary || executionReportSummary(report);
      const retryable = report.entries.some((entry) => entry.status === "failed" || entry.status === "not-run");
      node.innerHTML = `
        <span>步骤：成功 ${summary.success} · 失败 ${summary.failed} · 跳过 / 未执行 ${summary.skipped} · 覆盖 ${summary.overwrite}</span>
        ${retryable ? '<button class="ol-tmdb-report-retry" type="button">准备重试失败 / 未执行步骤</button>' : ""}
        ${summary.failed ? '<button class="ol-tmdb-report-copy" type="button">复制失败明细</button>' : ""}
      `;
      $(".ol-tmdb-report-retry", node)?.addEventListener("click", prepareFailedRetry);
      $(".ol-tmdb-report-copy", node)?.addEventListener("click", copyExecutionReport);
    }

    function renderCompatibilityWarnings() {
      const node = $(".ol-tmdb-compatibility");
      if (!node) return;
      if (!state.compatibilityWarnings.length) {
        node.innerHTML = "";
        return;
      }
      node.innerHTML = `
        <strong>兼容性提示</strong>
        ${state.compatibilityWarnings.map((warning) => `<span>${escapeHtml(warning.message)}</span>`).join("")}
      `;
    }

    function renderPermissionSummary() {
      const node = $(".ol-tmdb-permissions");
      if (!node) return;
      const capabilities = operationCapabilities();
      const permissionNote = capabilities.permissionKnown
        ? "已读取当前用户权限"
        : "未能确认用户权限，操作将由服务端最终判断";
      node.dataset.kind = capabilities.rename ? "" : "readonly";
      node.innerHTML = `
        <strong>${capabilities.rename ? "可用写入能力" : "只读模式"}</strong>
        <span data-allowed="${capabilities.rename}">改名：${capabilities.rename ? "可用" : escapeHtml(capabilities.renameReason)}</span>
        <span data-allowed="${capabilities.structuring}">目录结构化：${capabilities.structuring ? "可用" : escapeHtml(capabilities.renameReason)}</span>
        <small>${escapeHtml(permissionNote)}；TMDB 搜索、预览和元数据检查始终可用。</small>
      `;
    }

    const updatePermissionControls = () => {
      const capabilities = operationCapabilities();
      const update = (selector, allowed, reason) => {
        const input = $(selector);
        if (!input) return;
        input.disabled = state.loading || !allowed;
        const label = input.closest?.("label");
        if (label) {
          label.dataset.permissionDisabled = String(!allowed);
          label.title = allowed ? "" : reason;
        }
      };
      update(".ol-tmdb-do-rename", capabilities.rename, capabilities.renameReason);
      update(".ol-tmdb-do-structuring", capabilities.structuring, capabilities.renameReason);
      document.querySelectorAll("[data-only-operation]").forEach((button) => {
        const operation = button.dataset.onlyOperation;
        const allowed = operation === "rename" ? capabilities.rename : capabilities.structuring;
        button.disabled = state.loading || !allowed;
        button.title = allowed ? "" : capabilities.renameReason;
      });
      document.querySelectorAll(".ol-tmdb-cleanup-execute").forEach((button) => {
        button.disabled = state.loading || !capabilities.rename;
        button.title = capabilities.rename ? "" : capabilities.renameReason;
      });
      renderPermissionSummary();
    };

    const setStatus = (message, kind = "") => {
      const node = $(".ol-tmdb-status");
      if (!node) return;
      node.textContent = message || "";
      node.dataset.kind = kind;
    };

    const setBusy = (busy) => {
      state.loading = busy;
      document.querySelectorAll(".ol-tmdb-action, .ol-tmdb-input, .ol-tmdb-select, .ol-tmdb-file input, .ol-tmdb-check input, .ol-tmdb-cleanup-row input").forEach((el) => {
        if (el.dataset.keepEnabled === "true") return;
        el.disabled = busy;
      });
      if (!busy) updatePermissionControls();
    };

    const authHeaders = (extra = {}) => ({
      Authorization: localStorage.getItem("token") || "",
      ...extra,
    });

    const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

    const retryDelay = (response, attempt) => {
      const raw = response?.headers?.get?.("retry-after")?.trim();
      if (raw) {
        const seconds = Number(raw);
        if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
        const retryAt = Date.parse(raw);
        if (Number.isFinite(retryAt)) return Math.max(0, retryAt - Date.now());
      }
      return 500 * (2 ** attempt);
    };

    const fetchWithPolicy = async (url, options = {}, policy = {}) => {
      const {
        timeoutMs = REQUEST_TIMEOUTS.tmdb,
        label = "网络",
        maxRetries = 0,
        retryStatuses = new Set(),
        retryNetwork = false,
        onResponse,
        onRetry,
        consume = async (response) => response,
      } = policy;
      const callerSignal = options.signal;

      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        const controller = new AbortController();
        let timedOut = false;
        let delayMs = null;
        const abortFromCaller = () => controller.abort(callerSignal?.reason);
        if (callerSignal?.aborted) abortFromCaller();
        else callerSignal?.addEventListener?.("abort", abortFromCaller, { once: true });
        const timeoutId = setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs);

        try {
          const response = await fetch(url, { ...options, signal: controller.signal });
          onResponse?.(response);
          if (retryStatuses.has(response.status) && attempt < maxRetries) {
            delayMs = retryDelay(response, attempt);
            onRetry?.({ attempt: attempt + 1, delayMs, status: response.status });
            try {
              await response.body?.cancel?.();
            } catch {
              // The retry is still safe if the unused response body cannot be cancelled.
            }
          } else {
            const body = await consume(response);
            return { response, body, attempts: attempt + 1 };
          }
        } catch (error) {
          if (callerSignal?.aborted && !timedOut) throw error;
          const transient = timedOut || error?.name === "AbortError" || error instanceof TypeError;
          if (transient && retryNetwork && attempt < maxRetries) {
            delayMs = 500 * (2 ** attempt);
            onRetry?.({ attempt: attempt + 1, delayMs, status: null });
          } else if (timedOut || error?.name === "AbortError") {
            const timeoutError = new Error(`${label}请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
            timeoutError.code = "REQUEST_TIMEOUT";
            timeoutError.cause = error;
            throw timeoutError;
          } else if (transient) {
            const networkError = new Error(`${label}不可达：${error?.message || "网络连接失败"}`);
            networkError.code = "NETWORK_UNREACHABLE";
            networkError.cause = error;
            throw networkError;
          } else {
            throw error;
          }
        } finally {
          clearTimeout(timeoutId);
          callerSignal?.removeEventListener?.("abort", abortFromCaller);
        }

        if (delayMs !== null) await sleep(delayMs);
      }
      throw new Error(`${label}请求失败`);
    };

    const openListRequest = async (path, options = {}) => {
      const {
        timeoutMs = REQUEST_TIMEOUTS.openListRead,
        requestLabel = "OpenList API",
        ...requestOptions
      } = options;
      const { response, body } = await fetchWithPolicy(
        `${apiBase()}/api${path}`,
        {
          ...requestOptions,
          headers: authHeaders(requestOptions.headers || {}),
        },
        {
          timeoutMs,
          label: requestLabel,
          consume: (result) => result.text(),
        },
      );
      const contentType = response.headers.get("content-type") || "";
      let payload;
      if (contentType.includes("application/json")) {
        try {
          payload = JSON.parse(body);
        } catch {
          throw new Error("OpenList API 返回了无效 JSON，可能需要适配当前版本");
        }
      } else {
        payload = { code: response.status, message: body };
      }
      if (!payload || typeof payload !== "object") {
        throw new Error("OpenList API 响应格式无效，可能需要适配当前版本");
      }
      if (!response.ok || (payload.code && payload.code !== 200)) {
        throw new Error(payload.message || `OpenList API ${response.status}`);
      }
      if (!("data" in payload)) {
        throw new Error("OpenList API 响应缺少 data 字段，可能需要适配当前版本");
      }
      return payload.data;
    };

    const loadCurrentUserPermissions = async () => {
      const token = localStorage.getItem("token") || "";
      if (state.permissionLoaded && state.permissionToken === token) return;
      state.permissionLoaded = false;
      state.permissionToken = token;
      state.userPermission = null;
      try {
        const user = await openListRequest("/me", {
          method: "GET",
          timeoutMs: 10_000,
          requestLabel: "OpenList 当前用户",
        });
        if (state.permissionToken !== token) return;
        if (!user || !Number.isInteger(user.permission)) {
          throw new Error("当前用户响应缺少 permission 字段");
        }
        state.userPermission = user.permission;
        state.permissionLoaded = true;
        removeCompatibilityWarning("user-permission");
      } catch (error) {
        if (state.permissionToken !== token) return;
        state.userPermission = null;
        state.permissionLoaded = true;
        addCompatibilityWarning(
          "user-permission",
          `无法确认当前用户权限（${error.message}）；目录允许的写入选项保持可用，并由服务端最终判断。`,
        );
      }
    };

    const fsList = async (path) =>
      openListRequest("/fs/list", {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUTS.openListRead,
        requestLabel: "OpenList 文件列表",
        headers: { "Content-Type": "application/json;charset=utf-8" },
        body: JSON.stringify({ path, password: "", page: 1, per_page: 0, refresh: false }),
      });

    const batchRename = async (srcDir, renameObjects) =>
      openListRequest("/fs/batch_rename", {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUTS.openListWrite,
        requestLabel: "OpenList 改名",
        headers: { "Content-Type": "application/json;charset=utf-8" },
        body: JSON.stringify({
          src_dir: srcDir,
          rename_objects: renameObjects,
        }),
      });

    const makeDir = async (path) =>
      openListRequest("/fs/mkdir", {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUTS.openListWrite,
        requestLabel: "OpenList 创建目录",
        headers: { "Content-Type": "application/json;charset=utf-8" },
        body: JSON.stringify({ path }),
      });

    const moveFiles = async (srcDir, dstDir, names) =>
      openListRequest("/fs/move", {
        method: "POST",
        timeoutMs: REQUEST_TIMEOUTS.openListWrite,
        requestLabel: "OpenList 移动文件",
        headers: { "Content-Type": "application/json;charset=utf-8" },
        body: JSON.stringify({ src_dir: srcDir, dst_dir: dstDir, names }),
      });

    const noteTmdbRateLimit = () => {
      state.tmdbRateLimited = true;
      state.tmdbConcurrency = Math.max(1, Math.floor(state.tmdbConcurrency / 2));
    };

    const tmdbConcurrencyNotice = () =>
      state.tmdbRateLimited ? `（TMDB 限流，后续并发已降至 ${state.tmdbConcurrency}）` : "";

    const tmdbRequest = async (path, params = {}) => {
      const inputKey = $(".ol-tmdb-api-key")?.value.trim();
      const key = inputKey || DEFAULT_TMDB_API_KEY;
      if (!key) throw new Error("请先填写 TMDB API Key");
      if (inputKey) localStorage.setItem(STORAGE.key, inputKey);
      const url = new URL(`https://api.themoviedb.org/3${path}`);
      url.searchParams.set("language", $(".ol-tmdb-language")?.value || "zh-CN");
      Object.entries(params).forEach(([name, value]) => {
        if (value !== undefined && value !== null && value !== "") {
          url.searchParams.set(name, value);
        }
      });

      const headers = {};
      const normalizedKey = key.replace(/^Bearer\s+/i, "").trim();
      if (normalizedKey.startsWith("eyJ") || normalizedKey.length > 64) {
        headers.Authorization = `Bearer ${normalizedKey}`;
      } else {
        url.searchParams.set("api_key", normalizedKey);
      }
      const cacheUrl = new URL(url);
      cacheUrl.searchParams.delete("api_key");
      const cacheKey = cacheUrl.toString();
      if (tmdbSessionCache.has(cacheKey)) return tmdbSessionCache.get(cacheKey);
      if (tmdbInflightRequests.has(cacheKey)) return tmdbInflightRequests.get(cacheKey);

      const request = (async () => {
        const { response, body } = await fetchWithPolicy(
          url,
          { headers },
          {
            timeoutMs: REQUEST_TIMEOUTS.tmdb,
            label: "TMDB API",
            maxRetries: TMDB_MAX_RETRIES,
            retryStatuses: TMDB_RETRY_STATUSES,
            retryNetwork: true,
            onResponse: (result) => {
              if (result.status === 429) noteTmdbRateLimit();
            },
            consume: (result) => result.text(),
          },
        );
        let payload = {};
        try {
          payload = body ? JSON.parse(body) : {};
        } catch {
          if (response.ok) throw new Error("TMDB API 返回了无效 JSON");
        }
        if (!response.ok) {
          const authMode = headers.Authorization ? "Bearer token" : "v3 api_key";
          const detail = payload.status_message || "";
          if (response.status === 401 || response.status === 403) {
            throw new Error(`TMDB 鉴权失败（${authMode}）${detail ? `：${detail}` : ""}`);
          }
          if (response.status === 404) {
            throw new Error(`TMDB 条目或剧集不存在${detail ? `：${detail}` : ""}`);
          }
          if (response.status === 400 || response.status === 422) {
            throw new Error(`TMDB 请求参数无效${detail ? `：${detail}` : ""}`);
          }
          throw new Error(
            detail
              ? `TMDB API ${response.status} (${authMode})：${detail}`
              : `TMDB API ${response.status} (${authMode})`,
          );
        }
        tmdbSessionCache.set(cacheKey, payload);
        return payload;
      })();
      tmdbInflightRequests.set(cacheKey, request);
      try {
        return await request;
      } finally {
        tmdbInflightRequests.delete(cacheKey);
      }
    };

    const searchMovie = async (query, year) =>
      tmdbRequest("/search/movie", {
        query,
        year,
        include_adult: "false",
      });

    const searchTv = async (query, year) =>
      tmdbRequest("/search/tv", {
        query,
        first_air_date_year: year,
        include_adult: "false",
      });

    const getMovieDetails = async (id) =>
      tmdbRequest(`/movie/${id}`, {
        append_to_response: "credits,release_dates",
      });

    const getTvDetails = async (id) =>
      tmdbRequest(`/tv/${id}`, {
        append_to_response: "credits",
      });

    const getTvEpisode = async (id, seasonNumber, episodeNumber) =>
      tmdbRequest(`/tv/${id}/season/${seasonNumber}/episode/${episodeNumber}`);

    const buildImageUrl = (path, size = "w185") =>
      path ? `https://image.tmdb.org/t/p/${size}${path}` : "";

    const syncTvBatchRows = () => {
      if (state.mode !== "tv") {
        state.tvBatchRows = [];
        return;
      }
      const existingRows = new Map(state.tvBatchRows.map((row) => [row.name, row]));
      const selectedSet = new Set(state.selectedNames);
      state.selectedNames = state.files
        .map((file) => file.name)
        .filter((name) => selectedSet.has(name));
      state.tvBatchRows = state.selectedNames.map((name) => {
        const parsed = parseEpisodeName(name);
        const previous = existingRows.get(name);
        const season = positiveNumber(previous?.season) || parsed?.season || "";
        const episode = positiveNumber(previous?.episode) || parsed?.episode || "";
        const sameEpisode =
          previous &&
          positiveNumber(previous.season) === positiveNumber(season) &&
          positiveNumber(previous.episode) === positiveNumber(episode);
        return {
          name,
          parsed: Boolean(parsed),
          season,
          episode,
          episodeDetails: sameEpisode ? previous.episodeDetails : null,
          error: sameEpisode ? previous.error || "" : "",
          result: previous?.result || "",
        };
      });
    };

    const batchRowStatus = (row) => {
      if (!positiveNumber(row.season) || !positiveNumber(row.episode)) {
        return { text: "待填写季 / 集", kind: "error" };
      }
      if (row.error) return { text: row.error, kind: "error" };
      if (row.result) return { text: row.result, kind: "ok" };
      if (row.episodeDetails) return { text: "已匹配", kind: "ok" };
      return { text: row.parsed ? "待更新" : "已手动填写，待更新", kind: "" };
    };

    const normalizeSeriesTitle = (value) =>
      String(value || "")
        .normalize("NFKC")
        .replace(/\[[^\]]*]/g, " ")
        .replace(/\b(?:19|20)\d{2}\b/g, " ")
        .replace(/\b(?:season|s)\s*\d+\b/gi, " ")
        .replace(/第\s*\d+\s*季/g, " ")
        .replace(/[^\p{L}\p{N}]+/gu, "")
        .toLowerCase();

    const batchRowSuspicion = (row) => {
      if (!state.selectedItem) return "";
      const parsedTitle = parseEpisodeName(row.name)?.title || "";
      const candidate = normalizeSeriesTitle(parsedTitle);
      if (candidate.length < 2) return "";
      const references = [
        itemDisplayTitle(state.selectedItem),
        state.selectedItem.original_name,
        currentDirectoryTitle(),
      ]
        .map(normalizeSeriesTitle)
        .filter((value, index, values) => value.length >= 2 && values.indexOf(value) === index);
      const matches = references.some((reference) =>
        candidate.includes(reference) || reference.includes(candidate)
      );
      return matches ? "" : `文件标题“${parsedTitle}”与所选条目疑似不一致`;
    };

    const batchOverview = (rows = state.tvBatchRows) => {
      const episodes = rows
        .map((row) => ({ season: positiveNumber(row.season), episode: positiveNumber(row.episode) }))
        .filter((item) => item.season && item.episode)
        .sort((a, b) => a.season - b.season || a.episode - b.episode);
      const seasons = new Set(episodes.map((item) => item.season));
      const first = episodes[0];
      const last = episodes.at(-1);
      const range = !first
        ? "待填写"
        : first.season === last.season && first.episode === last.episode
          ? tvEpisodeCode(first.season, first.episode)
          : `${tvEpisodeCode(first.season, first.episode)}–${tvEpisodeCode(last.season, last.episode)}`;
      const suspiciousRows = rows.filter((row) => batchRowSuspicion(row));
      return {
        selected: rows.length,
        seasonCount: seasons.size,
        range,
        unparsed: rows.filter((row) => !row.parsed).length,
        suspiciousRows,
      };
    };

    const batchFillDefaults = (rows = state.tvBatchRows) => ({
      season: positiveNumber(rows[0]?.season) || 1,
      episode: positiveNumber(rows[0]?.episode) || 1,
    });

    const renderBatchOverview = (rows = state.tvBatchRows) => {
      const overview = batchOverview(rows);
      const defaults = batchFillDefaults(rows);
      const selectedTitle = state.selectedItem ? itemDisplayTitle(state.selectedItem) : "";
      const suspiciousNames = overview.suspiciousRows.slice(0, 3).map((row) => row.name);
      return `
        <div class="ol-tmdb-batch-overview">
          <div class="ol-tmdb-batch-confirmation">
            <strong>同一 TMDB 条目约束</strong>
            <span>${selectedTitle
              ? `以下 ${overview.selected} 个文件将全部使用“${escapeHtml(selectedTitle)}”这一条电视剧记录。`
              : `这 ${overview.selected} 个文件必须共用同一个 TMDB 电视剧条目，请确认选择中没有混入其他剧集。`}</span>
          </div>
          <div class="ol-tmdb-batch-summary">
            <span>文件：${overview.selected}</span>
            <span>季数：${overview.seasonCount || "待填写"}</span>
            <span>范围：${escapeHtml(overview.range)}</span>
            <span>无法解析：${overview.unparsed}</span>
            <span>疑似异剧集：${overview.suspiciousRows.length}</span>
          </div>
          ${overview.suspiciousRows.length ? `
            <div class="ol-tmdb-batch-suspicion">
              <strong>非阻断提示：</strong>
              <span>${escapeHtml(suspiciousNames.join("；"))}${overview.suspiciousRows.length > suspiciousNames.length ? `；另 ${overview.suspiciousRows.length - suspiciousNames.length} 个` : ""}</span>
            </div>
          ` : ""}
          <div class="ol-tmdb-batch-fill">
            <span>按当前文件顺序覆盖填充</span>
            <label>季 <input class="ol-tmdb-input ol-tmdb-fill-season" type="text" inputmode="numeric" value="${defaults.season}"></label>
            <label>起始集 <input class="ol-tmdb-input ol-tmdb-fill-episode" type="text" inputmode="numeric" value="${defaults.episode}"></label>
            <button class="ol-tmdb-action ol-tmdb-fill-sequential" type="button">连续填充</button>
          </div>
        </div>
      `;
    };

    const batchRowTarget = (row) => {
      const file = state.files.find((item) => item.name === row.name);
      const season = positiveNumber(row.season);
      const episode = positiveNumber(row.episode);
      if (!file || !state.selectedItem || !season || !episode) {
        return { videoName: "" };
      }
      const base = tvEpisodeBaseName(state.selectedItem, row.episodeDetails, season, episode);
      return {
        videoName: `${base}.${extname(file.name)}`,
      };
    };

    const buildSingleExecutionPlan = (options = actionOptions()) => {
      const file = selectedFile();
      if (!file || !state.selectedItem) {
        return finalizeExecutionPlan({ options, rows: [], steps: [] });
      }
      const finalVideoName = options.rename ? targetVideoName() : file.name;
      const target = { videoName: finalVideoName };
      const steps = [
        renamePlanStep("single:rename", file.name, target.videoName, options.rename),
      ];
      if (options.structuring) {
        const targetDir = structuringTargetDir();
        steps.push(mkdirPlanStep("single:mkdir", targetDir, true));
        steps.push(movePlanStep("single:move", target.videoName, targetDir, true));
      }
      return finalizeExecutionPlan({
        options,
        rows: [{ file, sourceName: file.name, target, steps }],
        steps,
      });
    };

    const buildBatchExecutionPlan = (options = actionOptions()) => {
      const mkdirDirs = new Set();
      const rowPlans = state.tvBatchRows.map((row, index) => {
        const file = state.files.find((item) => item.name === row.name);
        const matchedTarget = batchRowTarget(row);
        if (!file || !row.episodeDetails || !matchedTarget.videoName) {
          const validation = planStep(
            `batch:${index}:validation`,
            "validation",
            "剧集",
            row.name,
            "pending",
            row.error || (!file ? "原文件不存在" : "待获取 TMDB 集信息"),
          );
          return { row, file, sourceName: row.name, target: matchedTarget, steps: [validation] };
        }
        const finalVideoName = options.rename ? matchedTarget.videoName : row.name;
        const target = { videoName: finalVideoName };
        const steps = [
          renamePlanStep(`batch:${index}:rename`, row.name, target.videoName, options.rename),
        ];
        if (options.structuring) {
          const season = positiveNumber(row.season) || 1;
          const seasonDir = structuringSeasonDir(season);
          if (!mkdirDirs.has(seasonDir)) {
            mkdirDirs.add(seasonDir);
            steps.push(mkdirPlanStep(`batch:${index}:mkdir`, seasonDir, true));
          }
          steps.push(movePlanStep(`batch:${index}:move`, target.videoName, seasonDir, true));
        }
        return { row, file, sourceName: row.name, target, steps };
      });

      const episodeGroups = new Map();
      rowPlans.forEach((rowPlan) => {
        if (!rowPlan.row.episodeDetails) return;
        const key = `${positiveNumber(rowPlan.row.season)}:${positiveNumber(rowPlan.row.episode)}`;
        const group = episodeGroups.get(key) || [];
        group.push(rowPlan);
        episodeGroups.set(key, group);
      });
      episodeGroups.forEach((group) => {
        if (group.length < 2) return;
        group.forEach((rowPlan) => {
          rowPlan.steps.push(planStep(
            `${rowPlan.sourceName}:duplicate-episode`,
            "validation",
            "季集",
            tvEpisodeCode(rowPlan.row.season, rowPlan.row.episode),
            "conflict",
            "季 / 集重复",
          ));
        });
      });

      const targetGroups = new Map();
      rowPlans.forEach((rowPlan) => {
        if (rowPlan.steps.some((step) => step.type === "validation" && step.blocking)) return;
        rowPlan.steps.forEach((step, index) => {
          if (!["rename"].includes(step.type) || !step.name) return;
          if (["disabled", "unavailable", "pending"].includes(step.status)) return;
          const key = `${step.type}:${normalizeName(step.name)}`;
          const group = targetGroups.get(key) || [];
          group.push({ rowPlan, index });
          targetGroups.set(key, group);
        });
      });
      targetGroups.forEach((group) => {
        if (group.length < 2) return;
        group.forEach(({ rowPlan, index }) => {
          rowPlan.steps[index] = conflictingPlanStep(rowPlan.steps[index], "批量目标重复");
        });
      });

      const steps = rowPlans.flatMap((rowPlan) => rowPlan.steps);
      return finalizeExecutionPlan({ options, rows: rowPlans, steps });
    };

    const buildCleanupExecutionPlan = () => {
      const rowPlans = state.cleanupRows
        .filter((row) => row.selected)
        .map((row, index) => ({
          row,
          sourceName: row.sourceName,
          target: { videoName: row.targetName },
          steps: [renamePlanStep(
            `cleanup:${index}:${row.sourceName}`,
            row.sourceName,
            row.targetName,
            true,
          )],
        }));
      const targets = new Map();
      rowPlans.forEach((rowPlan) => {
        const key = normalizeName(rowPlan.target.videoName);
        const group = targets.get(key) || [];
        group.push(rowPlan);
        targets.set(key, group);
      });
      targets.forEach((group) => {
        if (group.length < 2) return;
        group.forEach((rowPlan) => {
          rowPlan.steps[0] = conflictingPlanStep(rowPlan.steps[0], "清理后的目标名重复");
        });
      });
      return finalizeExecutionPlan({
        options: { rename: true, structuring: false },
        rows: rowPlans,
        steps: rowPlans.flatMap((rowPlan) => rowPlan.steps),
      });
    };

    const updateBatchInput = (input) => {
      const row = state.tvBatchRows.find((item) => item.name === input.dataset.name);
      if (!row) return;
      row[input.dataset.field] = positiveNumber(input.value) || "";
      row.episodeDetails = null;
      row.error = "";
      row.result = "";
    };

    const fillSequentialEpisodes = (season, firstEpisode) => {
      const normalizedSeason = positiveNumber(season);
      const normalizedEpisode = positiveNumber(firstEpisode);
      if (!normalizedSeason || !normalizedEpisode) return false;
      state.tvBatchRows.forEach((row, index) => {
        row.season = normalizedSeason;
        row.episode = normalizedEpisode + index;
        row.episodeDetails = null;
        row.error = "";
        row.result = "";
      });
      return true;
    };

    const bindBatchOverviewActions = (preview) => {
      $(".ol-tmdb-fill-sequential", preview)?.addEventListener("click", () => {
        const season = $(".ol-tmdb-fill-season", preview)?.value;
        const episode = $(".ol-tmdb-fill-episode", preview)?.value;
        if (!fillSequentialEpisodes(season, episode)) {
          setStatus("连续填充需要有效的季和起始集", "error");
          return;
        }
        const count = state.tvBatchRows.length;
        renderPreview();
        setStatus(`已按文件顺序填充 ${count} 集；请检查后更新逐集预览`, "ok");
      });
    };

    const fetchTvBatchEpisodes = async (rows = state.tvBatchRows) => {
      let success = 0;
      let failed = 0;

      const validRows = [];
      for (const row of rows) {
        row.result = "";
        const season = positiveNumber(row.season);
        const episode = positiveNumber(row.episode);
        if (!season || !episode) {
          row.episodeDetails = null;
          row.error = "请填写季 / 集";
          failed += 1;
        } else {
          validRows.push(row);
        }
      }

      let completed = 0;
      const total = validRows.length;

      const fetchOne = async (row) => {
        const season = positiveNumber(row.season);
        const episode = positiveNumber(row.episode);
        try {
          row.episodeDetails = await getTvEpisode(state.selectedItem.id, season, episode);
          row.error = "";
          success += 1;
        } catch (error) {
          row.episodeDetails = null;
          row.error = error.message;
          failed += 1;
        }
        completed += 1;
        setStatus(`正在读取剧集信息 (${completed}/${total})...`);
      };

      const pool = new Map();
      for (let i = 0; i < validRows.length; i += 1) {
        const task = fetchOne(validRows[i]).then(() => i);
        pool.set(i, task);
        while (pool.size >= state.tmdbConcurrency) {
          const done = await Promise.race(pool.values());
          pool.delete(done);
        }
      }
      await Promise.all(pool.values());

      return { success, failed, concurrency: state.tmdbConcurrency };
    };

    const hydrateTvBatchEpisodes = async () => {
      if (!isTvBatchActive()) {
        setStatus("请在电视剧模式下选择至少两集", "error");
        return;
      }
      if (!state.selectedItem) {
        setStatus("请先选择 TMDB 电视剧条目", "error");
        return;
      }
      syncTvBatchRows();
      setBusy(true);
      try {
        const result = await fetchTvBatchEpisodes();
        render();
        setStatus(
          result.failed
            ? `已更新 ${result.success} 集，${result.failed} 项需要修正${tmdbConcurrencyNotice()}`
            : `已更新 ${result.success} 集${tmdbConcurrencyNotice()}`,
          result.failed ? "error" : "ok",
        );
      } finally {
        setBusy(false);
      }
    };

    const renderFiles = () => {
      const list = $(".ol-tmdb-files");
      if (!list) return;
      if (!state.files.length) {
        list.innerHTML = '<div class="ol-tmdb-file"><div></div><div class="ol-tmdb-name">当前目录没有视频文件</div><div></div></div>';
        return;
      }
      const tvMode = state.mode === "tv";
      const selectedSet = new Set(state.selectedNames);
      list.innerHTML = state.files
        .map(
          (file) => {
            const selected = tvMode ? selectedSet.has(file.name) : file.name === state.selectedName;
            return `<label class="ol-tmdb-file" data-selected="${selected}">
            <input type="${tvMode ? "checkbox" : "radio"}" name="${tvMode ? "ol-tmdb-tv-file" : "ol-tmdb-file"}" value="${escapeHtml(file.name)}" ${selected ? "checked" : ""}>
            <span class="ol-tmdb-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
            <span class="ol-tmdb-meta">${formatSize(file.size)}</span>
          </label>`;
          },
        )
        .join("");
      list.querySelectorAll("input").forEach((input) => {
        input.addEventListener("change", () => {
          if (state.mode === "tv") {
            if (input.checked) {
              state.selectedNames = [...new Set([...state.selectedNames, input.value])];
              state.selectedName = input.value;
            } else {
              state.selectedNames = state.selectedNames.filter((name) => name !== input.value);
              if (state.selectedName === input.value) state.selectedName = state.selectedNames[0] || "";
            }
            const keepSelectedShow = state.selectedItem && state.selectedNames.length > 1;
            if (!keepSelectedShow) {
              state.selectedItem = null;
              state.results = [];
            }
            state.selectedEpisode = null;
            syncTvBatchRows();
          } else {
            state.selectedName = input.value;
            state.selectedNames = [input.value];
            state.selectedItem = null;
            state.selectedEpisode = null;
            state.results = [];
          }
          hydrateSearchFromFile();
          render();
        });
      });
    };

    const normalizeDuplicateTitle = (value) => {
      CLEANUP_TECHNICAL_PATTERN.lastIndex = 0;
      const withoutTechnical = String(value || "")
        .replace(CLEANUP_TECHNICAL_PATTERN, " ")
        .replace(CLEANUP_AD_PATTERN, " ")
        .replace(CLEANUP_DOMAIN_PATTERN, " ")
        .replace(/\[[^\]]*]|【[^】]*】|\{[^}]*}/g, " ");
      return normalizeSeriesTitle(withoutTechnical);
    };

    const duplicateSizeAssessment = (files) => {
      const sizes = files.map((file) => Number(file.size)).filter((size) => Number.isFinite(size) && size > 0);
      if (sizes.length < 2) return { kind: "unknown", text: "缺少足够的文件大小信息" };
      const minimum = Math.min(...sizes);
      const maximum = Math.max(...sizes);
      const difference = maximum ? ((maximum - minimum) / maximum) * 100 : 0;
      return difference <= 10
        ? { kind: "close", text: `大小接近（最大差 ${difference.toFixed(1)}%）` }
        : { kind: "different", text: `大小差异较大（最大差 ${difference.toFixed(1)}%）` };
    };

    const inspectDuplicates = () => {
      const groups = new Map();
      state.files.forEach((file) => {
        let descriptor;
        if (state.mode === "tv") {
          const episode = parseEpisodeName(file.name);
          if (!episode) return;
          const title = episode.title || currentDirectoryTitle();
          const titleKey = normalizeDuplicateTitle(title);
          if (!titleKey) return;
          descriptor = {
            key: `tv:${titleKey}:${episode.season}:${episode.episode}`,
            title,
            season: episode.season,
            episode: episode.episode,
          };
        } else {
          const movie = parseMovieName(file.name);
          const titleKey = normalizeDuplicateTitle(movie.title);
          if (!titleKey) return;
          descriptor = {
            key: `movie:${titleKey}:${movie.year || "unknown"}`,
            title: movie.title,
            year: movie.year,
          };
        }
        const group = groups.get(descriptor.key) || { ...descriptor, files: [] };
        group.files.push(file);
        groups.set(descriptor.key, group);
      });
      const duplicates = [...groups.values()]
        .filter((group) => group.files.length > 1)
        .map((group) => ({ ...group, size: duplicateSizeAssessment(group.files) }))
        .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: "base" }));
      state.duplicateReport = {
        mode: state.mode,
        groups: duplicates,
        candidateFiles: duplicates.reduce((count, group) => count + group.files.length, 0),
      };
      return state.duplicateReport;
    };

    const inspectMetadata = () => {
      const names = new Set(state.entries.filter((item) => !item.is_dir).map((item) => normalizeName(item.name)));
      const hasAnyPoster = ["poster.jpg", "folder.jpg", "cover.jpg"].some((name) => names.has(name));
      const rows = state.files.map((file) => {
        const base = basename(file.name);
        const nfoName = `${base}.nfo`;
        const jpgName = `${base}.jpg`;
        const posterName = `${base}-poster.jpg`;
        const issues = [];
        if (!names.has(normalizeName(nfoName))) issues.push("缺失 NFO");
        if (!names.has(normalizeName(jpgName)) && !names.has(normalizeName(posterName)) && !hasAnyPoster) {
          issues.push("缺失 JPG / poster");
        }
        if (state.mode === "tv") {
          const episode = parseEpisodeName(file.name);
          if (!episode) {
            issues.push("季集解析失败");
          } else if (!standardEpisodePattern.test(file.name)) {
            issues.push(`命名不规范：建议包含 ${tvEpisodeCode(episode.season, episode.episode)}`);
          }
        } else {
          const parsed = parseMovieName(file.name);
          if (!parsed.year) issues.push("命名不规范：缺少年份");
          if (parsed.year && !/\((?:19|20)\d{2}\)/.test(base)) {
            issues.push(`命名不规范：建议使用 (${parsed.year})`);
          }
        }
        return {
          name: file.name,
          issues,
        };
      });
      const summary = {
        total: rows.length,
        ok: rows.filter((row) => !row.issues.length).length,
        missingNfo: rows.filter((row) => row.issues.some((issue) => issue.includes("NFO"))).length,
        missingImage: rows.filter((row) => row.issues.some((issue) => issue.includes("JPG"))).length,
        naming: rows.filter((row) => row.issues.some((issue) => issue.includes("命名") || issue.includes("季集"))).length,
      };
      state.metadataReport = { rows, summary, mode: state.mode };
    };

    const renderMetadataReport = () => {
      const node = $(".ol-tmdb-audit");
      if (!node) return;
      if (!state.metadataReport) {
        node.innerHTML = "";
        return;
      }
      const { rows, summary, mode } = state.metadataReport;
      if (!rows.length) {
        node.innerHTML = '<div class="ol-tmdb-audit-empty">当前目录没有可检查的视频文件</div>';
        return;
      }
      node.innerHTML = `
        <div class="ol-tmdb-audit-head">
          <div>
            <strong>元数据检查报告</strong>
            <span class="ol-tmdb-meta">${mode === "tv" ? "电视剧" : "电影"}模式 · ${summary.total} 个视频 · ${summary.ok} 个通过</span>
          </div>
          <button class="ol-tmdb-action ol-tmdb-audit-clear" type="button">收起</button>
        </div>
        <div class="ol-tmdb-audit-summary">
          <span>缺 NFO：${summary.missingNfo}</span>
          <span>缺图片：${summary.missingImage}</span>
          <span>命名问题：${summary.naming}</span>
        </div>
        <div class="ol-tmdb-audit-table">
          ${rows.map((row) => `
            <div class="ol-tmdb-audit-row" data-kind="${row.issues.length ? "warn" : "ok"}">
              <span class="ol-tmdb-code" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
              <span>${row.issues.length ? escapeHtml(row.issues.join("；")) : "完整"}</span>
            </div>
          `).join("")}
        </div>
      `;
      $(".ol-tmdb-audit-clear", node)?.addEventListener("click", () => {
        state.metadataReport = null;
        renderMetadataReport();
        setStatus("");
      });
    };

    const renderDuplicateReport = () => {
      const node = $(".ol-tmdb-duplicates");
      if (!node) return;
      const report = state.duplicateReport;
      if (!report) {
        node.innerHTML = "";
        return;
      }
      node.innerHTML = `
        <div class="ol-tmdb-duplicate-head">
          <div>
            <strong>疑似重复报告</strong>
            <span class="ol-tmdb-meta">${report.groups.length} 组 · ${report.candidateFiles} 个文件 · 仅报告，不会删除</span>
          </div>
          <button class="ol-tmdb-action ol-tmdb-duplicate-clear" type="button">收起</button>
        </div>
        ${report.groups.length ? `
          <div class="ol-tmdb-duplicate-groups">
            ${report.groups.map((group) => `
              <section class="ol-tmdb-duplicate-group" data-size-kind="${group.size.kind}">
                <div class="ol-tmdb-duplicate-title">
                  <strong>${escapeHtml(group.title || "未知标题")}${report.mode === "tv"
                    ? ` · ${tvEpisodeCode(group.season, group.episode)}`
                    : ` · ${escapeHtml(group.year || "未知年份")}`}</strong>
                  <span>${escapeHtml(group.size.text)}</span>
                </div>
                ${group.files.map((file) => `
                  <div class="ol-tmdb-duplicate-file">
                    <span class="ol-tmdb-code" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
                    <span>${escapeHtml(formatSize(file.size) || "大小未知")}</span>
                  </div>
                `).join("")}
              </section>
            `).join("")}
          </div>
        ` : '<div class="ol-tmdb-cleanup-empty">未发现具有相同规范化标题/年份或剧名/季/集的文件。</div>'}
      `;
      $(".ol-tmdb-duplicate-clear", node)?.addEventListener("click", () => {
        state.duplicateReport = null;
        renderDuplicateReport();
        setStatus("");
      });
    };

    const renderCleanupPreview = () => {
      const node = $(".ol-tmdb-cleanup-preview");
      if (!node) return;
      if (!state.cleanupGenerated) {
        node.innerHTML = '<div class="ol-tmdb-cleanup-empty">选择规则后生成预览；不会自动改名。</div>';
        return;
      }
      if (!state.cleanupRows.length) {
        node.innerHTML = '<div class="ol-tmdb-cleanup-empty">当前规则没有发现需要清理的视频文件名。</div>';
        return;
      }
      const plan = buildCleanupExecutionPlan();
      const capabilities = operationCapabilities();
      node.innerHTML = `
        ${renderPlanSummary(plan)}
        <div class="ol-tmdb-cleanup-toolbar">
          <button class="ol-tmdb-action ol-tmdb-cleanup-select-all" type="button">全选候选</button>
          <button class="ol-tmdb-action ol-tmdb-cleanup-select-none" type="button">全部取消</button>
          <button class="ol-tmdb-action ol-tmdb-cleanup-execute" type="button" ${capabilities.rename ? "" : "disabled"} title="${escapeHtml(capabilities.renameReason)}">执行所选改名</button>
        </div>
        <div class="ol-tmdb-cleanup-table">
          ${state.cleanupRows.map((row) => {
            const rowPlan = plan.rows.find((item) => item.row === row);
            const step = rowPlan?.steps[0];
            const status = row.result || (step ? step.text : "未选择");
            const kind = row.result ? "ok" : step?.blocking ? "error" : "";
            return `
              <label class="ol-tmdb-cleanup-row" data-kind="${kind}">
                <input type="checkbox" data-source-name="${escapeHtml(row.sourceName)}" ${row.selected ? "checked" : ""}>
                <span class="ol-tmdb-code" title="${escapeHtml(row.sourceName)}">${escapeHtml(row.sourceName)}</span>
                <span class="ol-tmdb-cleanup-arrow">→</span>
                <span class="ol-tmdb-code" title="${escapeHtml(row.targetName)}">${escapeHtml(row.targetName)}</span>
                <span class="ol-tmdb-meta">${escapeHtml(row.rules.join("、"))}</span>
                <span class="ol-tmdb-cleanup-status">${escapeHtml(status)}</span>
              </label>
            `;
          }).join("")}
        </div>
      `;
      node.querySelectorAll(".ol-tmdb-cleanup-row input").forEach((input) => {
        input.addEventListener("change", () => {
          const row = state.cleanupRows.find((item) => item.sourceName === input.dataset.sourceName);
          if (row) row.selected = input.checked;
          renderCleanupPreview();
        });
      });
      $(".ol-tmdb-cleanup-select-all", node)?.addEventListener("click", () => {
        state.cleanupRows.forEach((row) => { row.selected = true; });
        renderCleanupPreview();
      });
      $(".ol-tmdb-cleanup-select-none", node)?.addEventListener("click", () => {
        state.cleanupRows.forEach((row) => { row.selected = false; });
        renderCleanupPreview();
      });
      $(".ol-tmdb-cleanup-execute", node)?.addEventListener("click", executeCleanupRename);
    };

    const renderResults = () => {
      const list = $(".ol-tmdb-results");
      if (!list) return;
      if (!state.results.length) {
        list.innerHTML = '<div class="ol-tmdb-result"><div></div><div class="ol-tmdb-name">暂无搜索结果</div><div></div></div>';
        return;
      }
      list.innerHTML = state.results
        .map((item) => {
          const title = itemDisplayTitle(item);
          const year = itemYear(item);
          const selected = state.selectedItem?.id === item.id;
          const poster = buildImageUrl(item.poster_path, "w154");
          const original = state.mode === "tv" ? item.original_name : item.original_title;
          const tmdbUrl = `https://www.themoviedb.org/${state.mode === "tv" ? "tv" : "movie"}/${item.id}`;
          return `<div class="ol-tmdb-result" role="button" tabindex="0" data-id="${item.id}" data-selected="${selected}">
            ${poster ? `<img class="ol-tmdb-poster" alt="" src="${escapeHtml(poster)}">` : '<div class="ol-tmdb-poster"></div>'}
            <div>
              <div class="ol-tmdb-name" title="${escapeHtml(title)}">${escapeHtml(title)}</div>
              <div class="ol-tmdb-meta">${escapeHtml(year || "未知年份")} · ${escapeHtml((original || "").slice(0, 80))}</div>
            </div>
            <div class="ol-tmdb-result-actions">
              <a class="ol-tmdb-result-link" href="${escapeHtml(tmdbUrl)}" target="_blank" rel="noopener noreferrer" title="在 TMDB 打开" aria-label="在 TMDB 打开">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </a>
              <button class="ol-tmdb-action" type="button" data-id="${item.id}">选择</button>
            </div>
          </div>`;
        })
        .join("");
      list.querySelectorAll(".ol-tmdb-result").forEach((row) => {
        row.addEventListener("click", () => selectItem(Number(row.dataset.id)));
        row.addEventListener("keydown", (event) => {
          if (event.key === "Enter" || event.key === " ") selectItem(Number(row.dataset.id));
        });
      });
      list.querySelectorAll(".ol-tmdb-result-link").forEach((link) => {
        link.addEventListener("click", (event) => event.stopPropagation());
      });
    };

    const renderBatchPreview = (preview) => {
      syncTvBatchRows();
      if (!state.selectedNames.length) {
        preview.innerHTML = "请选择一个或多个电视剧视频文件";
        return;
      }
      if (!state.selectedItem) {
        preview.innerHTML = `
          ${renderBatchOverview(state.tvBatchRows)}
          <div class="ol-tmdb-batch-select-hint">已选择 ${state.selectedNames.length} 个文件，请搜索并选择一个 TMDB 电视剧条目。</div>
        `;
        bindBatchOverviewActions(preview);
        return;
      }
      const rows = state.tvBatchRows;
      const plan = buildBatchExecutionPlan();
      preview.innerHTML = `
        ${renderBatchOverview(rows)}
        <div class="ol-tmdb-preview-head">
          <div>
            <strong>逐集预览</strong>
            <span class="ol-tmdb-meta">${escapeHtml(itemDisplayTitle(state.selectedItem))} · ${rows.length} 集</span>
          </div>
          <button class="ol-tmdb-action ol-tmdb-update-batch" type="button">更新逐集预览</button>
        </div>
        ${renderPlanSummary(plan)}
        <div class="ol-tmdb-batch-table">
          <div class="ol-tmdb-batch-head">
            <span>原文件</span>
            <span>季</span>
            <span>集</span>
            <span>TMDB 集名</span>
            <span>输出</span>
            <span>状态</span>
          </div>
          ${rows.map((row) => {
            const rowPlan = plan.rows.find((item) => item.row === row);
            const target = rowPlan?.target || batchRowTarget(row);
            const planError = rowPlan?.steps.find((step) => step.blocking);
            const status = planError
              ? { text: planError.text, kind: "error" }
              : batchRowStatus(row);
            const suspicion = batchRowSuspicion(row);
            const displayStatus = suspicion && status.kind !== "error"
              ? { text: `${suspicion}；${status.text}`, kind: "warn" }
              : status;
            return `<div class="ol-tmdb-batch-row" data-kind="${escapeHtml(displayStatus.kind)}">
              <span class="ol-tmdb-code" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
              <input class="ol-tmdb-input ol-tmdb-batch-input" data-name="${escapeHtml(row.name)}" data-field="season" type="text" inputmode="numeric" value="${escapeHtml(row.season)}">
              <input class="ol-tmdb-input ol-tmdb-batch-input" data-name="${escapeHtml(row.name)}" data-field="episode" type="text" inputmode="numeric" value="${escapeHtml(row.episode)}">
              <span>${escapeHtml(row.episodeDetails?.name || "")}</span>
              <span class="ol-tmdb-batch-target">
                ${target.videoName ? escapeHtml(target.videoName) : "待填写"}
                ${rowPlan ? `<span class="ol-tmdb-plan">${rowPlan.steps.map(renderPlanStep).join("")}</span>` : ""}
              </span>
              <span class="ol-tmdb-batch-status">${escapeHtml(displayStatus.text)}</span>
            </div>`;
          }).join("")}
        </div>
      `;
      bindBatchOverviewActions(preview);
      $(".ol-tmdb-update-batch", preview)?.addEventListener("click", hydrateTvBatchEpisodes);
      preview.querySelectorAll(".ol-tmdb-batch-input").forEach((input) => {
        input.addEventListener("change", () => {
          updateBatchInput(input);
          renderPreview();
        });
        input.addEventListener("keydown", (event) => {
          if (event.key === "Enter") {
            updateBatchInput(input);
            hydrateTvBatchEpisodes();
          }
        });
      });
    };

    const renderPreview = () => {
      const preview = $(".ol-tmdb-preview");
      if (!preview) return;
      if (isTvBatchActive()) {
        renderBatchPreview(preview);
        return;
      }
      const file = selectedFile();
      if (!file) {
        preview.innerHTML = "请选择一个视频文件";
        return;
      }
      if (!state.selectedItem) {
        preview.innerHTML = `请选择一个 TMDB ${state.mode === "tv" ? "电视剧" : "电影"}条目`;
        return;
      }
      const plan = buildSingleExecutionPlan();
      const rowPlan = plan.rows[0];
      const { videoName } = rowPlan.target;
      const structuringEnabled = Boolean($(".ol-tmdb-do-structuring")?.checked);
      const targetDir = structuringEnabled ? structuringTargetDir() : "";
      preview.innerHTML = `
        ${renderPlanSummary(plan)}
        <div><strong>原文件</strong> <span class="ol-tmdb-code">${escapeHtml(file.name)}</span></div>
        <div><strong>新文件</strong> <span class="ol-tmdb-code">${escapeHtml(videoName)}</span></div>
        ${targetDir ? `<div><strong>目标目录</strong> <span class="ol-tmdb-code">${escapeHtml(targetDir)}</span></div>` : ""}
        <div class="ol-tmdb-plan">${rowPlan.steps.map(renderPlanStep).join("")}</div>
      `;
    };

    const render = () => {
      renderFiles();
      renderResults();
      renderPreview();
      renderMetadataReport();
      renderDuplicateReport();
      renderCleanupPreview();
      renderExecutionReport();
      renderCompatibilityWarnings();
      updatePermissionControls();
      const executeButton = $(".ol-tmdb-execute");
      if (executeButton) executeButton.textContent = isTvBatchActive() ? "批量执行" : "执行";
    };

    const updateModeUi = () => {
      const modeFields = $(".ol-tmdb-mode-fields");
      if (modeFields) modeFields.dataset.mode = state.mode;
      const modal = $(".ol-tmdb-modal");
      if (modal) modal.dataset.mode = state.mode;
      const title = $("#ol-tmdb-title");
      if (title) title.textContent = `TMDB ${state.mode === "tv" ? "电视剧" : "电影"}匹配`;
    };

    const formatSize = (value) => {
      if (!Number.isFinite(value) || value <= 0) return "";
      const units = ["B", "KB", "MB", "GB", "TB"];
      let size = value;
      let index = 0;
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024;
        index += 1;
      }
      return `${size.toFixed(index ? 1 : 0)} ${units[index]}`;
    };

    const hydrateSearchFromFile = () => {
      const file = selectedFile();
      if (!file) return;
      const episode = parseEpisodeName(file.name);
      if (state.mode === "tv") {
        $(".ol-tmdb-query").value = episode?.title || currentDirectoryTitle();
        $(".ol-tmdb-year").value = "";
        $(".ol-tmdb-season").value = episode?.season || 1;
        $(".ol-tmdb-episode").value = episode?.episode || "";
        return;
      }
      const parsed = parseMovieName(file.name);
      $(".ol-tmdb-query").value = parsed.title;
      $(".ol-tmdb-year").value = parsed.year;
    };

    const chooseNextFileName = (previousName, renamedName) => {
      const previousEpisode = parseEpisodeName(previousName);
      const candidates = state.files
        .filter((file) => file.name !== previousName && file.name !== renamedName)
        .map((file) => ({ file, episode: parseEpisodeName(file.name) }))
        .filter(({ episode }) => state.mode !== "tv" || episode)
        .sort((a, b) => {
          if (state.mode === "tv") {
            return a.episode.season - b.episode.season || a.episode.episode - b.episode.episode;
          }
          return a.file.name.localeCompare(b.file.name, undefined, { numeric: true, sensitivity: "base" });
        });
      if (!candidates.length) return "";
      if (state.mode === "tv" && previousEpisode) {
        const next = candidates.find(({ episode }) =>
          episode.season > previousEpisode.season ||
          (episode.season === previousEpisode.season && episode.episode > previousEpisode.episode)
        );
        if (next) return next.file.name;
      }
      return candidates[0].file.name;
    };

    const loadFiles = async (preferredName = "") => {
      const requestedPath = currentOpenListPath();
      const loadId = state.directoryLoadId + 1;
      state.directoryLoadId = loadId;
      const [data] = await Promise.all([
        fsList(requestedPath),
        loadCurrentUserPermissions(),
      ]);
      if (loadId !== state.directoryLoadId || requestedPath !== currentOpenListPath()) {
        return false;
      }
      if (!data || typeof data !== "object") {
        throw new Error("OpenList 文件列表响应格式无效");
      }
      if (!("content" in data)) {
        throw new Error("OpenList 文件列表缺少 content 字段，可能需要适配当前版本");
      }
      if (data.content !== null && data.content !== undefined && !Array.isArray(data.content)) {
        throw new Error("OpenList 文件列表 content 格式异常，可能需要适配当前版本");
      }
      const entries = Array.isArray(data.content) ? data.content : [];
      if (entries.some((entry) => !entry || typeof entry.name !== "string" || typeof entry.is_dir !== "boolean")) {
        throw new Error("OpenList 文件条目格式异常，可能需要适配当前版本");
      }
      if (!("write" in data)) {
        addCompatibilityWarning("fs-list-write", "文件列表响应缺少 write 字段，写入操作将保持禁用。");
      }
      if (!("write_content_bypass" in data)) {
        addCompatibilityWarning("fs-list-write-bypass", "文件列表响应缺少 write_content_bypass 字段，权限提示可能不完整。");
      }
      state.currentPath = requestedPath;
      state.write = Boolean(data.write);
      state.writeContentBypass = Boolean(data.write_content_bypass);
      state.entries = entries;
      state.files = state.entries.filter(isVideo);
      const savedMode = localStorage.getItem(STORAGE.mode);
      state.mode = savedMode === "movie" || savedMode === "tv" ? savedMode : inferMode(state.files);
      const modeSelect = $(".ol-tmdb-mode");
      if (modeSelect) modeSelect.value = state.mode;
      updateModeUi();
      state.selectedName =
        (preferredName && state.files.some((file) => file.name === preferredName) && preferredName) ||
        (state.selectedName && state.files.some((file) => file.name === state.selectedName) && state.selectedName) ||
        state.files[0]?.name ||
        "";
      if (state.mode === "tv") {
        const available = new Set(state.files.map((file) => file.name));
        const previousSelected = state.selectedNames.filter((name) => available.has(name));
        state.selectedNames =
          previousSelected.length && (!preferredName || previousSelected.includes(preferredName))
            ? previousSelected
            : preferredName && state.selectedName === preferredName
              ? [preferredName]
              : state.selectedName
                ? [state.selectedName]
                : [];
        syncTvBatchRows();
      } else {
        state.selectedNames = state.selectedName ? [state.selectedName] : [];
        state.tvBatchRows = [];
      }
      if (state.selectedName) hydrateSearchFromFile();
      state.metadataReport = null;
      render();
      const capabilities = operationCapabilities();
      if (!capabilities.rename) {
        setStatus(`已以只读模式载入 ${state.files.length} 个视频文件；仍可搜索、预览和检查元数据`);
      } else {
        setStatus(`已载入 ${state.files.length} 个视频文件；可用写入能力：改名、目录结构化`);
      }
      return true;
    };

    const findOpenListRefreshControl = () => {
      const toolbar = $(".left-toolbar-in") || $(".left-toolbar");
      if (!toolbar) return null;
      const selectors = [
        ".toolbar-refresh",
        '[data-tool="refresh"]',
        '[tips="refresh"]',
        '[aria-label="refresh"]',
        '[aria-label="Refresh"]',
        '[aria-label="刷新"]',
      ];
      for (const selector of selectors) {
        const candidate = $(selector, toolbar);
        if (candidate && !candidate.closest?.(".ol-tmdb-button-wrap")) return candidate;
      }
      return null;
    };

    const triggerOpenListRefresh = () => {
      const control = findOpenListRefreshControl();
      if (!control || typeof control.click !== "function") {
        if ($(".left-toolbar-in") || $(".left-toolbar")) {
          addCompatibilityWarning("refresh-control", "无法识别 OpenList 内部刷新按钮，操作后仅使用文件 API 回读。");
        }
        return false;
      }
      try {
        control.click();
        return true;
      } catch {
        addCompatibilityWarning("refresh-control-click", "OpenList 内部刷新按钮触发失败，已改用文件 API 回读。");
        return false;
      }
    };

    const refreshFilesAfterMutation = async (preferredName = "") => {
      triggerOpenListRefresh();
      return loadFiles(preferredName);
    };

    const executeCleanupRename = async () => {
      if (!ensureLoadedDirectory()) return;
      const capabilities = operationCapabilities();
      if (!capabilities.rename) {
        setStatus(`无法执行文件名清理：${capabilities.renameReason}`, "error");
        return;
      }
      const plan = buildCleanupExecutionPlan();
      if (!plan.rows.length) {
        setStatus("请至少选择一个文件名清理候选", "error");
        return;
      }
      if (plan.blocking.length) {
        setStatus(`文件名清理存在 ${plan.blocking.length} 个目标冲突，请取消或调整对应项`, "error");
        return;
      }

      setBusy(true);
      const report = beginExecutionReport(plan);
      const renameObjects = plan.rows.map((rowPlan) => ({
        src_name: rowPlan.sourceName,
        new_name: rowPlan.target.videoName,
      }));
      try {
        setStatus(`正在清理 ${renameObjects.length} 个文件名...`);
        await batchRename(state.currentPath, renameObjects);
        plan.rows.forEach((rowPlan) => {
          rowPlan.row.result = "改名完成";
          updateExecutionReport(report, rowPlan.steps[0], "success");
        });
        const summary = finishExecutionReport(report);
        await refreshFilesAfterMutation(renameObjects[0]?.new_name || "");
        state.cleanupRows = [];
        state.cleanupGenerated = false;
        render();
        setStatus(`文件名清理完成：成功 ${summary.success} 项`, "ok");
      } catch (error) {
        let reloadError = null;
        try {
          await refreshFilesAfterMutation();
        } catch (failure) {
          reloadError = failure;
        }
        let recovered = 0;
        plan.rows.forEach((rowPlan) => {
          const sourceExists = Boolean(findEntry(rowPlan.sourceName));
          const targetExists = Boolean(findEntry(rowPlan.target.videoName));
          if (!sourceExists && targetExists) {
            rowPlan.row.selected = false;
            rowPlan.row.result = "服务端报错前已生效";
            updateExecutionReport(report, rowPlan.steps[0], "success");
            recovered += 1;
          } else {
            rowPlan.row.result = sourceExists ? "未改名，可重试" : "文件状态不明，请检查目录";
            updateExecutionReport(
              report,
              rowPlan.steps[0],
              "failed",
              reloadError ? `${error.message}；目录回读失败：${reloadError.message}` : error.message,
            );
          }
        });
        const summary = finishExecutionReport(report);
        renderCleanupPreview();
        setStatus(
          `文件名清理未完全成功：确认已生效 ${recovered} 项，待重试 ${summary.failed} 项${reloadError ? "；目录回读失败" : ""}`,
          "error",
        );
      } finally {
        setBusy(false);
      }
    };

    const runMetadataCheck = () => {
      inspectMetadata();
      renderMetadataReport();
      const summary = state.metadataReport.summary;
      const failed = summary.total - summary.ok;
      setStatus(
        failed
          ? `检查完成：${summary.total - summary.ok} 个视频存在待补项`
          : `检查完成：${summary.total} 个视频均通过`,
        failed ? "error" : "ok",
      );
    };

    const runDuplicateCheck = () => {
      const report = inspectDuplicates();
      renderDuplicateReport();
      setStatus(
        report.groups.length
          ? `发现 ${report.groups.length} 组疑似重复，共 ${report.candidateFiles} 个文件；请人工确认`
          : "未发现疑似重复文件",
        report.groups.length ? "error" : "ok",
      );
    };

    const doSearch = async () => {
      const query = $(".ol-tmdb-query").value.trim();
      const year = $(".ol-tmdb-year").value.trim();
      if (!query) {
        setStatus("请输入搜索关键词", "error");
        return;
      }
      setBusy(true);
      setStatus("正在搜索 TMDB...");
      try {
        localStorage.setItem(STORAGE.language, $(".ol-tmdb-language").value);
        localStorage.setItem(STORAGE.mode, state.mode);
        const payload = state.mode === "tv" ? await searchTv(query, year) : await searchMovie(query, year);
        state.results = (payload.results || []).slice(0, 10);
        state.selectedItem = null;
        state.selectedEpisode = null;
        render();
        setStatus(state.results.length ? `找到 ${state.results.length} 个结果` : "TMDB 无搜索结果", state.results.length ? "" : "error");
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        setBusy(false);
      }
    };

    const selectItem = async (id) => {
      setBusy(true);
      setStatus(`正在读取${state.mode === "tv" ? "电视剧" : "电影"}详情...`);
      try {
        state.selectedItem = state.mode === "tv" ? await getTvDetails(id) : await getMovieDetails(id);
        state.selectedEpisode = null;
        if (state.mode === "tv" && isTvBatchActive()) {
          syncTvBatchRows();
          const result = await fetchTvBatchEpisodes();
          render();
          setStatus(
            result.failed
              ? `已选择 TMDB 条目，${result.failed} 项需要修正${tmdbConcurrencyNotice()}`
              : `已选择 TMDB 条目，已匹配 ${result.success} 集${tmdbConcurrencyNotice()}`,
            result.failed ? "error" : "ok",
          );
          return;
        }
        if (state.mode === "tv") {
          const season = Number($(".ol-tmdb-season")?.value || 1);
          const episode = Number($(".ol-tmdb-episode")?.value || 0);
          if (episode > 0) {
            state.selectedEpisode = await getTvEpisode(id, season || 1, episode);
          }
        }
        render();
        setStatus("已选择 TMDB 条目", "ok");
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        setBusy(false);
      }
    };

    const executeTvBatch = async () => {
      syncTvBatchRows();
      if (!state.tvBatchRows.length) {
        setStatus("请选择要批量处理的电视剧文件", "error");
        return;
      }
      if (!state.selectedItem) {
        setStatus("请选择 TMDB 电视剧条目", "error");
        return;
      }
      const options = actionOptions();
      if (!options.rename && !options.structuring) {
        setStatus(noAvailableActionMessage(), "error");
        return;
      }
      const invalidRows = state.tvBatchRows.filter((row) => !positiveNumber(row.season) || !positiveNumber(row.episode));
      if (invalidRows.length) {
        invalidRows.forEach((row) => {
          row.error = "请填写季 / 集";
        });
        render();
        setStatus(`${invalidRows.length} 项缺少季 / 集，请先补齐`, "error");
        return;
      }

      setBusy(true);
      let report = null;
      let activeSteps = [];
      try {
        localStorage.setItem(STORAGE.rename, options.rename ? "true" : "false");
        localStorage.setItem(STORAGE.structuring, options.structuring ? "true" : "false");
        await fetchTvBatchEpisodes();
        const plan = buildBatchExecutionPlan(options);
        render();
        if (plan.blocking.length) {
          setStatus(`执行计划存在 ${plan.blocking.length} 个冲突或待补项，请先处理`, "error");
          return;
        }
        if (!plan.rows.length) {
          render();
          setStatus("没有可执行的剧集，请检查预览中的错误", "error");
          return;
        }

        report = beginExecutionReport(plan);

        let success = 0;
        if (options.rename) {
          const renamePlans = plan.rows.flatMap((rowPlan) => {
            const step = rowPlan.steps.find((item) => item.type === "rename");
            rowPlan.row._renamed = step?.run ? rowPlan.target.videoName : rowPlan.sourceName;
            return step?.run
              ? [{ rowPlan, step }]
              : [];
          });
          const renameObjects = renamePlans.map(({ rowPlan }) => ({
            src_name: rowPlan.sourceName,
            new_name: rowPlan.target.videoName,
          }));
          if (renameObjects.length) {
            setStatus(`正在批量改名 ${renameObjects.length} 个文件...`);
            activeSteps = renamePlans.map(({ step }) => step);
            await batchRename(state.currentPath, renameObjects);
            activeSteps.forEach((step) => updateExecutionReport(report, step, "success"));
            activeSteps = [];
          }
        }

        if (options.structuring) {
          if (options.rename) {
            const subRenameObjects = [];
            plan.rows.forEach((rowPlan) => {
              if (!rowPlan.row._renamed || rowPlan.row._renamed === rowPlan.sourceName) return;
              const subtitles = findSubtitleFilesFor(rowPlan.sourceName);
              subtitles.forEach((sub) => {
                const subTarget = subtitleTargetName(rowPlan.sourceName, rowPlan.row._renamed, sub.name);
                if (subTarget !== sub.name) {
                  subRenameObjects.push({ src_name: sub.name, new_name: subTarget });
                }
              });
            });
            if (subRenameObjects.length) {
              setStatus(`正在改名 ${subRenameObjects.length} 个字幕文件...`);
              await batchRename(state.currentPath, subRenameObjects);
            }
          }

          const mkdirSteps = plan.steps.filter((step) => step.type === "mkdir" && step.run);
          if (mkdirSteps.length) {
            setStatus(`正在创建 ${mkdirSteps.length} 个目录...`);
            activeSteps = mkdirSteps;
            for (const step of mkdirSteps) {
              await makeDir(step.name);
            }
            activeSteps.forEach((step) => updateExecutionReport(report, step, "success"));
            activeSteps = [];
          }

          const moveGroups = new Map();
          plan.rows.forEach((rowPlan) => {
            if (rowPlan.row.error) return;
            const season = positiveNumber(rowPlan.row.season) || 1;
            const seasonDir = structuringSeasonDir(season);
            const moveName = rowPlan.row._renamed || rowPlan.sourceName;
            const group = moveGroups.get(seasonDir) || [];
            group.push(moveName);
            const subtitles = findSubtitleFilesFor(rowPlan.sourceName);
            subtitles.forEach((sub) => {
              const subMoveName = options.rename
                ? subtitleTargetName(rowPlan.sourceName, rowPlan.row._renamed || rowPlan.sourceName, sub.name)
                : sub.name;
              group.push(subMoveName);
            });
            moveGroups.set(seasonDir, group);
          });

          const moveSteps = plan.steps.filter((step) => step.type === "move" && step.run);
          activeSteps = moveSteps;
          for (const [targetDir, names] of moveGroups) {
            setStatus(`正在移动 ${names.length} 个文件...`);
            await moveFiles(state.currentPath, targetDir, names);
          }
          activeSteps.forEach((step) => updateExecutionReport(report, step, "success"));
          activeSteps = [];
        }

        plan.rows.forEach((rowPlan) => {
          const row = rowPlan.row;
          if (row._renamed) {
            row.result = row._renamed === rowPlan.sourceName ? "文件名无需变更" : "改名完成";
            row.name = row._renamed;
          } else {
            row.result = "完成";
          }
          success += 1;
        });

        const failedRows = state.tvBatchRows.filter((row) => row.error);
        const failedNames = failedRows.map((row) => row.name);
        const finalFailed = failedNames.length;
        const retainedNames = finalFailed ? failedNames : [];
        const reportSummary = finishExecutionReport(report);
        state.selectedNames = retainedNames;
        state.selectedName = retainedNames[0] || "";
        state.selectedEpisode = failedRows.length === 1 ? failedRows[0].episodeDetails : null;
        if (!retainedNames.length) {
          state.selectedItem = null;
          state.results = [];
          state.tvBatchRows = [];
        }
        if (reportSummary.success) {
          await refreshFilesAfterMutation(retainedNames[0] || "");
        } else {
          await loadFiles(retainedNames[0] || "");
        }
        if (failedRows.length === 1) {
          const seasonInput = $(".ol-tmdb-season");
          const episodeInput = $(".ol-tmdb-episode");
          if (seasonInput) seasonInput.value = failedRows[0].season;
          if (episodeInput) episodeInput.value = failedRows[0].episode;
        }
        render();
        setStatus(
          finalFailed
            ? `批量完成 ${success} 集，失败 ${finalFailed} 集；步骤成功 ${reportSummary.success}，跳过 ${reportSummary.skipped}`
            : `批量完成 ${success} 集；步骤成功 ${reportSummary.success}，跳过 ${reportSummary.skipped}`,
          finalFailed ? "error" : "ok",
        );
      } catch (error) {
        const failedSteps = error.planStep ? [error.planStep] : activeSteps;
        failedSteps.forEach((step) => updateExecutionReport(report, step, "failed", error.message));
        finishExecutionReport(report);
        setStatus(error.message, "error");
      } finally {
        setBusy(false);
      }
    };

    const execute = async () => {
      if (!ensureLoadedDirectory()) return;
      if (isTvBatchActive()) {
        await executeTvBatch();
        return;
      }
      const file = selectedFile();
      if (!file) {
        setStatus("请选择一个视频文件", "error");
        return;
      }
      if (!state.selectedItem) {
        setStatus(`请选择一个 TMDB ${state.mode === "tv" ? "电视剧" : "电影"}条目`, "error");
        return;
      }
      if (state.mode === "tv" && !Number($(".ol-tmdb-episode")?.value || 0)) {
        setStatus("电视剧模式需要填写集数", "error");
        return;
      }
      const options = actionOptions();
      if (!options.rename && !options.structuring) {
        setStatus(noAvailableActionMessage(), "error");
        return;
      }

      setBusy(true);
      const plan = buildSingleExecutionPlan(options);
      const rowPlan = plan.rows[0];
      const oldName = rowPlan.sourceName;
      const { videoName: newVideoName } = rowPlan.target;
      const messages = [];
      const nextName = chooseNextFileName(oldName, newVideoName);
      let actualName = oldName;
      let report = null;
      let activeStep = null;
      try {
        localStorage.setItem(STORAGE.rename, options.rename ? "true" : "false");
        localStorage.setItem(STORAGE.structuring, options.structuring ? "true" : "false");
        render();
        if (plan.blocking.length) {
          setStatus(`执行计划存在 ${plan.blocking.length} 个冲突，请先处理`, "error");
          return;
        }

        report = beginExecutionReport(plan);
        const renameStep = rowPlan.steps.find((step) => step.type === "rename");
        if (renameStep?.run) {
          setStatus("正在改名...");
          activeStep = renameStep;
          await batchRename(state.currentPath, [{ src_name: oldName, new_name: newVideoName }]);
          actualName = newVideoName;
          updateExecutionReport(report, renameStep, "success");
          activeStep = null;
          messages.push("改名完成");
        } else if (renameStep?.status === "unchanged") {
          messages.push("文件名无需变更");
        }

        if (options.structuring) {
          const targetDir = structuringTargetDir();
          if (options.rename && renameStep?.run) {
            const subtitles = findSubtitleFilesFor(oldName);
            const subRenameObjects = [];
            subtitles.forEach((sub) => {
              const subTarget = subtitleTargetName(oldName, newVideoName, sub.name);
              if (subTarget !== sub.name) {
                subRenameObjects.push({ src_name: sub.name, new_name: subTarget });
              }
            });
            if (subRenameObjects.length) {
              setStatus(`正在改名 ${subRenameObjects.length} 个字幕文件...`);
              await batchRename(state.currentPath, subRenameObjects);
              messages.push(`字幕改名 ${subRenameObjects.length} 个`);
            }
          }

          const mkdirStep = rowPlan.steps.find((step) => step.type === "mkdir");
          if (mkdirStep?.run) {
            setStatus("正在创建目录...");
            activeStep = mkdirStep;
            await makeDir(mkdirStep.name);
            updateExecutionReport(report, mkdirStep, "success");
            activeStep = null;
            messages.push("目录已创建");
          }

          const moveStep = rowPlan.steps.find((step) => step.type === "move");
          if (moveStep?.run) {
            const moveNames = [moveStep.name];
            const subtitles = findSubtitleFilesFor(oldName);
            subtitles.forEach((sub) => {
              const subMoveName = options.rename
                ? subtitleTargetName(oldName, newVideoName, sub.name)
                : sub.name;
              moveNames.push(subMoveName);
            });
            setStatus(`正在移动 ${moveNames.length} 个文件...`);
            activeStep = moveStep;
            await moveFiles(state.currentPath, targetDir, moveNames);
            updateExecutionReport(report, moveStep, "success");
            activeStep = null;
            messages.push("文件已移动");
          }
        }

        const reportSummary = finishExecutionReport(report);
        state.selectedItem = null;
        state.selectedEpisode = null;
        state.results = [];
        if (reportSummary.success) {
          await refreshFilesAfterMutation(nextName);
        } else {
          await loadFiles(nextName);
        }
        setStatus(
          nextName
            ? `${messages.join("，")}。步骤成功 ${reportSummary.success}，跳过 ${reportSummary.skipped}。已自动选中下一项：${nextName}`
            : `${messages.join("，")}。步骤成功 ${reportSummary.success}，跳过 ${reportSummary.skipped}。当前目录没有可继续处理的视频`,
          "ok",
        );
      } catch (error) {
        const failedStep = error.planStep || activeStep;
        if (failedStep) {
          updateExecutionReport(report, failedStep, "failed", error.message);
        }
        finishExecutionReport(report);
        try {
          if (activeStep || actualName !== oldName) {
            await refreshFilesAfterMutation(actualName);
          } else {
            await loadFiles(actualName);
          }
          setStatus(`${error.message}。已重新读取目录并定位当前文件`, "error");
        } catch (reloadError) {
          setStatus(`${error.message}；重新读取目录失败：${reloadError.message}`, "error");
        }
      } finally {
        setBusy(false);
      }
    };

    const createModal = () => {
      if ($("#ol-tmdb-mask")) return;
      const mask = document.createElement("div");
      mask.id = "ol-tmdb-mask";
      mask.className = "ol-tmdb-mask";
      mask.innerHTML = `
        <section class="ol-tmdb-modal" role="dialog" aria-modal="true" aria-labelledby="ol-tmdb-title">
          <header class="ol-tmdb-header">
            <h2 class="ol-tmdb-title" id="ol-tmdb-title">TMDB 匹配</h2>
            <button class="ol-tmdb-action ol-tmdb-close" type="button" data-keep-enabled="true">关闭</button>
          </header>
          <main class="ol-tmdb-body">
            <section class="ol-tmdb-panel">
              <div class="ol-tmdb-field">
                <label class="ol-tmdb-label">TMDB API Key</label>
                <input class="ol-tmdb-input ol-tmdb-api-key" type="password" autocomplete="off" placeholder="api_key">
              </div>
              <div class="ol-tmdb-row">
                <label class="ol-tmdb-field" style="flex: 1">
                  <select class="ol-tmdb-select ol-tmdb-language">
                    <option value="zh-CN">zh-CN</option>
                    <option value="zh-TW">zh-TW</option>
                    <option value="en-US">en-US</option>
                    <option value="ja-JP">ja-JP</option>
                  </select>
                </label>
                <button class="ol-tmdb-action ol-tmdb-reload" type="button">刷新文件</button>
                <button class="ol-tmdb-action ol-tmdb-audit-run" type="button">元数据检查</button>
                <button class="ol-tmdb-action ol-tmdb-duplicate-run" type="button">重复检测</button>
              </div>
              <div class="ol-tmdb-compatibility"></div>
              <div class="ol-tmdb-permissions"></div>
              <div class="ol-tmdb-list">
                <div class="ol-tmdb-list-head"><span></span><span>当前目录视频</span><span>大小</span></div>
                <div class="ol-tmdb-files"></div>
              </div>
              <div class="ol-tmdb-audit"></div>
              <div class="ol-tmdb-duplicates"></div>
              <div class="ol-tmdb-cleanup">
                <div class="ol-tmdb-cleanup-head">
                  <div>
                    <strong>文件名清理</strong>
                    <span class="ol-tmdb-meta">仅生成候选；执行前可逐项取消</span>
                  </div>
                  <button class="ol-tmdb-action ol-tmdb-cleanup-generate" type="button">生成清理预览</button>
                </div>
                <div class="ol-tmdb-row ol-tmdb-cleanup-rules">
                  <label class="ol-tmdb-check"><input class="ol-tmdb-cleanup-ads" type="checkbox" checked> 资源站 / 广告词</label>
                  <label class="ol-tmdb-check"><input class="ol-tmdb-cleanup-brackets" type="checkbox" checked> 无关括号</label>
                  <label class="ol-tmdb-check"><input class="ol-tmdb-cleanup-technical" type="checkbox"> 技术标签</label>
                </div>
                <div class="ol-tmdb-cleanup-preview"></div>
              </div>
              <div class="ol-tmdb-row ol-tmdb-tv-only ol-tmdb-batch-actions">
                <button class="ol-tmdb-action ol-tmdb-select-all-files" type="button">全选</button>
                <button class="ol-tmdb-action ol-tmdb-select-parsed-files" type="button">选择可解析</button>
                <button class="ol-tmdb-action ol-tmdb-clear-files" type="button">清空</button>
              </div>
            </section>
            <section class="ol-tmdb-panel">
              <div class="ol-tmdb-row ol-tmdb-mode-fields" data-mode="movie">
                <label class="ol-tmdb-field" style="flex: 1">
                  <span class="ol-tmdb-label">模式</span>
                  <select class="ol-tmdb-select ol-tmdb-mode">
                    <option value="movie">电影</option>
                    <option value="tv">电视剧</option>
                  </select>
                </label>
                <label class="ol-tmdb-field" style="flex: 1.5">
                  <span class="ol-tmdb-label">搜索词</span>
                  <input class="ol-tmdb-input ol-tmdb-query" type="text">
                </label>
                <label class="ol-tmdb-field ol-tmdb-movie-only" style="flex: 0.7">
                  <span class="ol-tmdb-label">年份</span>
                  <input class="ol-tmdb-input ol-tmdb-year" type="text" inputmode="numeric">
                </label>
                <label class="ol-tmdb-field ol-tmdb-tv-only" style="flex: 0.5">
                  <span class="ol-tmdb-label">季</span>
                  <input class="ol-tmdb-input ol-tmdb-season" type="text" inputmode="numeric">
                </label>
                <label class="ol-tmdb-field ol-tmdb-tv-only" style="flex: 0.5">
                  <span class="ol-tmdb-label">集</span>
                  <input class="ol-tmdb-input ol-tmdb-episode" type="text" inputmode="numeric">
                </label>
                <button class="ol-tmdb-action ol-tmdb-search" type="button" data-primary="true" style="align-self: end">搜索</button>
              </div>
              <div class="ol-tmdb-list">
                <div class="ol-tmdb-results"></div>
              </div>
              <div class="ol-tmdb-preview"></div>
              <div class="ol-tmdb-row ol-tmdb-operation-options">
                <label class="ol-tmdb-check"><input class="ol-tmdb-do-rename" type="checkbox"> 改名</label>
                <label class="ol-tmdb-check"><input class="ol-tmdb-do-structuring" type="checkbox"> 目录结构化</label>
                <label class="ol-tmdb-image-size-field ol-tmdb-tv-only">
                  <span>批量并发</span>
                  <select class="ol-tmdb-select ol-tmdb-concurrency">
                    <option value="1">1</option>
                    <option value="3">3</option>
                    <option value="5">5</option>
                  </select>
                </label>
                <span class="ol-tmdb-operation-quick">
                  <button class="ol-tmdb-action" type="button" data-only-operation="rename">仅改名</button>
                  <button class="ol-tmdb-action" type="button" data-only-operation="structuring">仅结构化</button>
                </span>
              </div>
            </section>
          </main>
          <footer class="ol-tmdb-footer">
            <div class="ol-tmdb-footer-info">
              <div class="ol-tmdb-status"></div>
              <div class="ol-tmdb-execution-report"></div>
            </div>
            <button class="ol-tmdb-action ol-tmdb-execute" type="button" data-primary="true">执行</button>
          </footer>
        </section>
      `;
      document.body.appendChild(mask);
      $(".ol-tmdb-close", mask).addEventListener("click", closeModal);
      $(".ol-tmdb-reload", mask).addEventListener("click", () => withStatus(loadFiles));
      $(".ol-tmdb-audit-run", mask).addEventListener("click", runMetadataCheck);
      $(".ol-tmdb-duplicate-run", mask).addEventListener("click", runDuplicateCheck);
      $(".ol-tmdb-cleanup-generate", mask).addEventListener("click", () => {
        const options = cleanupRuleOptions();
        if (!options.ads && !options.brackets && !options.technical) {
          setStatus("请至少选择一类文件名清理规则", "error");
          return;
        }
        const rows = generateCleanupRows(options);
        renderCleanupPreview();
        setStatus(rows.length ? `发现 ${rows.length} 个文件名清理候选` : "当前规则没有发现可清理的文件名", rows.length ? "ok" : "");
      });
      $(".ol-tmdb-select-all-files", mask).addEventListener("click", () => {
        state.selectedNames = state.files.map((file) => file.name);
        state.selectedName = state.selectedNames[0] || "";
        if (state.selectedNames.length < 2) {
          state.selectedItem = null;
          state.results = [];
        }
        state.selectedEpisode = null;
        syncTvBatchRows();
        hydrateSearchFromFile();
        render();
      });
      $(".ol-tmdb-select-parsed-files", mask).addEventListener("click", () => {
        const parsedNames = state.files
          .filter((file) => parseEpisodeName(file.name))
          .map((file) => file.name);
        if (!parsedNames.length) {
          setStatus("当前目录没有可自动解析季集的视频", "error");
          return;
        }
        state.selectedNames = parsedNames;
        state.selectedName = parsedNames[0];
        if (state.selectedNames.length < 2) {
          state.selectedItem = null;
          state.results = [];
        }
        state.selectedEpisode = null;
        syncTvBatchRows();
        hydrateSearchFromFile();
        render();
      });
      $(".ol-tmdb-clear-files", mask).addEventListener("click", () => {
        state.selectedNames = [];
        state.selectedName = "";
        state.selectedItem = null;
        state.selectedEpisode = null;
        state.results = [];
        state.tvBatchRows = [];
        render();
      });
      $(".ol-tmdb-mode", mask).addEventListener("change", (event) => {
        state.mode = event.target.value;
        localStorage.setItem(STORAGE.mode, state.mode);
        state.selectedNames = state.selectedName ? [state.selectedName] : [];
        state.selectedItem = null;
        state.selectedEpisode = null;
        state.tvBatchRows = [];
        state.results = [];
        updateModeUi();
        hydrateSearchFromFile();
        render();
      });
      $(".ol-tmdb-search", mask).addEventListener("click", doSearch);
      $(".ol-tmdb-query", mask).addEventListener("keydown", (event) => {
        if (event.key === "Enter") doSearch();
      });
      $(".ol-tmdb-year", mask).addEventListener("keydown", (event) => {
        if (event.key === "Enter") doSearch();
      });
      const optionStorage = new Map([
        ["ol-tmdb-do-rename", STORAGE.rename],
        ["ol-tmdb-do-structuring", STORAGE.structuring],
      ]);
      mask.querySelectorAll(".ol-tmdb-do-rename, .ol-tmdb-do-structuring").forEach((input) => {
        input.addEventListener("change", () => {
          const storageKey = [...input.classList]
            .map((className) => optionStorage.get(className))
            .find(Boolean);
          if (storageKey) localStorage.setItem(storageKey, input.checked ? "true" : "false");
          renderPreview();
        });
      });
      mask.querySelectorAll("[data-only-operation]").forEach((button) => {
        button.addEventListener("click", () => {
          const operation = button.dataset.onlyOperation;
          setOperationSelection(new Set([operation]));
          setStatus(`已切换为仅 ${operation === "rename" ? "改名" : "结构化"}`);
        });
      });
      $(".ol-tmdb-concurrency", mask).addEventListener("change", (event) => {
        const concurrency = Number(event.target.value);
        if (!TMDB_CONCURRENCY_OPTIONS.has(concurrency)) return;
        state.tmdbConcurrencyLimit = concurrency;
        state.tmdbConcurrency = concurrency;
        state.tmdbRateLimited = false;
        localStorage.setItem(STORAGE.concurrency, String(concurrency));
        setStatus(`批量 TMDB 请求并发已设为 ${concurrency}`);
      });
      $(".ol-tmdb-execute", mask).addEventListener("click", execute);
      mask.addEventListener("click", (event) => {
        if (event.target === mask) closeModal();
      });
      $(".ol-tmdb-api-key", mask).value = localStorage.getItem(STORAGE.key) || DEFAULT_TMDB_API_KEY || "";
      $(".ol-tmdb-language", mask).value = localStorage.getItem(STORAGE.language) || "zh-CN";
      $(".ol-tmdb-mode", mask).value = localStorage.getItem(STORAGE.mode) || state.mode;
      $(".ol-tmdb-do-rename", mask).checked = localStorage.getItem(STORAGE.rename) !== "false";
      $(".ol-tmdb-do-structuring", mask).checked = localStorage.getItem(STORAGE.structuring) === "true";
      $(".ol-tmdb-concurrency", mask).value = String(state.tmdbConcurrencyLimit);
      updateModeUi();
    };

    const withStatus = async (task) => {
      setBusy(true);
      setStatus("正在载入...");
      try {
        await task();
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        setBusy(false);
      }
    };

    const openModal = () => {
      const path = currentOpenListPath();
      if (path !== state.currentPath) resetDirectoryState(path);
      createModal();
      $("#ol-tmdb-mask").dataset.open = "true";
      state.results = [];
      state.selectedItem = null;
      state.selectedEpisode = null;
      withStatus(loadFiles);
    };

    const closeModal = () => {
      const mask = $("#ol-tmdb-mask");
      if (mask) mask.dataset.open = "false";
    };

    const buttonSvg = () => `
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2"></rect>
        <path d="M7 5v14M17 5v14M3 9h4M17 9h4M3 15h4M17 15h4"></path>
        <path d="M10 12h4"></path>
      </svg>`;

    const routeExcludesToolbar = () =>
      /^\/(?:@manage|@login|@test|@s)(?:\/|$)/i.test(currentOpenListPath());

    const removeStaleButtons = (toolbar = null) => {
      document.querySelectorAll(".ol-tmdb-button-wrap").forEach((wrap) => {
        if (!toolbar || wrap.parentElement !== toolbar) wrap.remove();
      });
    };

    const insertButton = (toolbarBox = $(".left-toolbar-box")) => {
      if (routeExcludesToolbar()) {
        removeStaleButtons();
        return false;
      }
      if (!toolbarBox) return false;
      const toolbar = $(".left-toolbar-in", toolbarBox) || $(".left-toolbar", toolbarBox);
      if (!toolbar) return false;
      removeStaleButtons(toolbar);
      if ($("#ol-tmdb-open", toolbar)) return true;
      const wrap = document.createElement("span");
      wrap.className = "ol-tmdb-button-wrap";
      const button = document.createElement("button");
      button.id = "ol-tmdb-open";
      button.className = "ol-tmdb-button";
      button.type = "button";
      button.setAttribute("aria-label", "TMDB 匹配");
      button.innerHTML = buttonSvg();
      button.addEventListener("click", openModal);
      const tip = document.createElement("span");
      tip.className = "ol-tmdb-tip";
      tip.textContent = "TMDB 匹配";
      wrap.appendChild(button);
      wrap.appendChild(tip);
      toolbar.appendChild(wrap);
      return true;
    };

    let scrollButtonDirection = null;
    let scrollUpdateScheduled = false;

    const detectScrollDirection = () => {
      const scrollTop = window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
      return scrollTop <= 1 ? "down" : "up";
    };

    const scrollButtonSvg = (direction) => {
      if (direction === "down") {
        return `
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 5v14M5 12l7 7 7-7"></path>
      </svg>`;
      }
      return `
      <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 19V5M5 12l7-7 7 7"></path>
      </svg>`;
    };

    const updateScrollButtonAppearance = () => {
      const button = $("#ol-tmdb-scroll");
      if (!button) {
        scrollButtonDirection = null;
        return;
      }
      const direction = detectScrollDirection();
      if (direction === scrollButtonDirection) return;
      scrollButtonDirection = direction;
      const tip = button.parentElement?.querySelector(".ol-tmdb-tip");
      button.innerHTML = scrollButtonSvg(direction);
      button.setAttribute("aria-label", direction === "up" ? "回到顶部" : "滚动到底部");
      if (tip) tip.textContent = direction === "up" ? "回到顶部" : "滚动到底部";
    };

    const handleScrollForButton = () => {
      if (scrollUpdateScheduled) return;
      scrollUpdateScheduled = true;
      requestAnimationFrame(() => {
        scrollUpdateScheduled = false;
        updateScrollButtonAppearance();
      });
    };

    const scrollToTarget = () => {
      const direction = detectScrollDirection();
      const maxScroll = Math.max(0, document.documentElement.scrollHeight - document.documentElement.clientHeight);
      window.scrollTo({ top: direction === "up" ? 0 : maxScroll, behavior: "smooth" });
    };

    const insertScrollButton = (toolbarBox = $(".left-toolbar-box")) => {
      if (routeExcludesToolbar()) return false;
      if (!toolbarBox) return false;
      const toolbar = $(".left-toolbar-in", toolbarBox) || $(".left-toolbar", toolbarBox);
      if (!toolbar) return false;
      if ($("#ol-tmdb-scroll", toolbar)) {
        updateScrollButtonAppearance();
        return true;
      }
      const wrap = document.createElement("span");
      wrap.className = "ol-tmdb-button-wrap";
      const button = document.createElement("button");
      button.id = "ol-tmdb-scroll";
      button.className = "ol-tmdb-button";
      button.type = "button";
      button.setAttribute("aria-label", "滚动");
      const tip = document.createElement("span");
      tip.className = "ol-tmdb-tip";
      wrap.appendChild(button);
      wrap.appendChild(tip);
      toolbar.appendChild(wrap);
      button.addEventListener("click", scrollToTarget);
      scrollButtonDirection = null;
      updateScrollButtonAppearance();
      return true;
    };

    let observedToolbarBox = null;
    let lifecycleScheduled = false;
    let searchTimer = 0;

    const toolbarObserver = new MutationObserver(() => {
      insertButton(observedToolbarBox);
      insertScrollButton(observedToolbarBox);
    });

    const searchObserver = new MutationObserver(() => {
      scheduleToolbarLifecycle();
    });

    const bodyObserver = new MutationObserver(() => {
      scheduleToolbarLifecycle();
    });

    const hideToolbarDiagnostic = () => {
      $("#ol-tmdb-toolbar-warning")?.remove();
    };

    const showToolbarDiagnostic = () => {
      if (routeExcludesToolbar() || $(".left-toolbar-box") || $("#ol-tmdb-toolbar-warning")) return;
      const warning = document.createElement("div");
      warning.id = "ol-tmdb-toolbar-warning";
      warning.className = "ol-tmdb-toolbar-warning";
      warning.setAttribute("role", "status");
      warning.innerHTML = `
        <span>TMDB 助手未找到 OpenList 工具栏，入口尚未加载。</span>
        <button type="button" data-action="retry">重试</button>
        <button type="button" data-action="dismiss" aria-label="关闭">×</button>
      `;
      warning.querySelector('[data-action="retry"]').addEventListener("click", () => {
        warning.remove();
        startToolbarSearch();
      });
      warning.querySelector('[data-action="dismiss"]').addEventListener("click", () => warning.remove());
      document.body.appendChild(warning);
    };

    const stopToolbarSearch = () => {
      searchObserver.disconnect();
      if (searchTimer) window.clearTimeout(searchTimer);
      searchTimer = 0;
    };

    const startToolbarSearch = () => {
      stopToolbarSearch();
      if (routeExcludesToolbar()) {
        hideToolbarDiagnostic();
        removeStaleButtons();
        return;
      }
      const toolbarBox = $(".left-toolbar-box");
      if (toolbarBox) {
        bindToolbarLifecycle();
        return;
      }
      searchObserver.observe(document.body, { childList: true, subtree: true });
      searchTimer = window.setTimeout(() => {
        searchObserver.disconnect();
        searchTimer = 0;
        showToolbarDiagnostic();
      }, 8000);
    };

    const bindToolbarLifecycle = () => {
      if (routeExcludesToolbar()) {
        toolbarObserver.disconnect();
        observedToolbarBox = null;
        stopToolbarSearch();
        hideToolbarDiagnostic();
        removeStaleButtons();
        return;
      }
      const nextToolbarBox = $(".left-toolbar-box");
      if (nextToolbarBox !== observedToolbarBox) {
        toolbarObserver.disconnect();
        observedToolbarBox = nextToolbarBox;
        if (observedToolbarBox) {
          toolbarObserver.observe(observedToolbarBox, { childList: true, subtree: true });
        }
      }
      if (observedToolbarBox) {
        stopToolbarSearch();
        hideToolbarDiagnostic();
        insertButton(observedToolbarBox);
        insertScrollButton(observedToolbarBox);
      } else {
        removeStaleButtons();
        startToolbarSearch();
      }
    };

    function scheduleToolbarLifecycle() {
      if (lifecycleScheduled) return;
      lifecycleScheduled = true;
      Promise.resolve().then(() => {
        lifecycleScheduled = false;
        bindToolbarLifecycle();
      });
    }

    const ROUTE_CHANGE_EVENT = "ol-tmdb-route-change";
    ["pushState", "replaceState"].forEach((method) => {
      const original = history[method];
      history[method] = function (...args) {
        const result = original.apply(this, args);
        window.dispatchEvent(new Event(ROUTE_CHANGE_EVENT));
        return result;
      };
    });

    const onRouteChange = () => {
      closeModal();
      const path = currentOpenListPath();
      if (path !== state.currentPath) resetDirectoryState(path);
      scheduleToolbarLifecycle();
      window.setTimeout(scheduleToolbarLifecycle, 50);
      window.setTimeout(scheduleToolbarLifecycle, 250);
    };

    window.addEventListener(ROUTE_CHANGE_EVENT, onRouteChange);
    window.addEventListener("popstate", onRouteChange);
    window.addEventListener("hashchange", onRouteChange);
    window.addEventListener("scroll", handleScrollForButton, { passive: true });
    bodyObserver.observe(document.body, { childList: true });
    inspectRuntimeCompatibility();
    bindToolbarLifecycle();
  })();
