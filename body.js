  (() => {
    "use strict";

    if (window.__OPENLIST_TMDB_MATCHER__) return;
    window.__OPENLIST_TMDB_MATCHER__ = true;

    const STORAGE = {
      key: "openlist_tmdb_api_key",
      language: "openlist_tmdb_language",
      rename: "openlist_tmdb_rename",
      structuring: "openlist_tmdb_structuring",
      concurrency: "openlist_tmdb_concurrency",
      includeEpisodeTitle: "openlist_tmdb_include_episode_title",
      embedTmdbId: "openlist_tmdb_embed_tmdb_id",
      tmdbIdFileMode: "openlist_tmdb_id_file_mode",
      includeYear: "openlist_tmdb_include_year",
      seasonDirFormat: "openlist_tmdb_season_dir_format",
      batchPreviewCollapsed: "openlist_tmdb_batch_preview_collapsed",
      subPreviewCollapsed: "openlist_tmdb_sub_preview_collapsed",
      subtitleSuffixStrategy: "openlist_tmdb_subtitle_suffix_strategy",
      subtitleAutoScan: "openlist_tmdb_subtitle_auto_scan",
      localSeasonMode: "openlist_tmdb_local_season_mode",
    };
    const DEFAULT_TMDB_API_KEY = document.currentScript?.dataset?.tmdbApiKey || "";
    const SEASON_DIR_FORMATS = ["season-2digit", "s-2digit", "season-1digit"];
    const TMDB_ID_FILE_MODES = ["files-both", "files-neither", "files-movie-only", "files-tv-only"];
    const SUBTITLE_SUFFIX_STRATEGIES = ["all", "original", "lang-only", "ext-only"];
    // 脚本版本号：修改此处即可全局更新对话框显示的版本标识
    const SCRIPT_VERSION = "Bate_V1.0.4_20260903";
    const DEFAULTS = {
      rename: true,
      structuring: false,
      includeEpisodeTitle: true,
      embedTmdbId: false,
      tmdbIdFileMode: "files-both",
      includeYear: true,
      seasonDirFormat: "season-2digit",
      subtitleSuffixStrategy: "lang-only",
      subtitleAutoScan: false,
      localSeasonMode: false,
    };
    const parseBool = (value, fallback = false) => {
      const lower = String(value ?? "").trim().toLowerCase();
      if (["true", "1", "yes", "on"].includes(lower)) return true;
      if (["false", "0", "no", "off", ""].includes(lower)) return false;
      return fallback;
    };
    const parseEnum = (value, allowed, fallback) => {
      const v = String(value ?? "").trim();
      return allowed.includes(v) ? v : fallback;
    };
    const datasetDefaults = () => {
      const ds = document.currentScript?.dataset || {};
      return {
        rename: parseBool(ds.defaultRename, DEFAULTS.rename),
        structuring: parseBool(ds.defaultStructuring, DEFAULTS.structuring),
        includeEpisodeTitle: parseBool(ds.defaultIncludeEpisodeTitle, DEFAULTS.includeEpisodeTitle),
        embedTmdbId: parseBool(ds.defaultEmbedTmdbId, DEFAULTS.embedTmdbId),
        tmdbIdFileMode: parseEnum(ds.defaultTmdbIdFileMode, TMDB_ID_FILE_MODES, DEFAULTS.tmdbIdFileMode),
        includeYear: parseBool(ds.defaultIncludeYear, DEFAULTS.includeYear),
        seasonDirFormat: parseEnum(ds.defaultSeasonDirFormat, SEASON_DIR_FORMATS, DEFAULTS.seasonDirFormat),
      };
    };
    const resolveBoolOption = (storageKey, datasetDefault) => {
      const stored = localStorage.getItem(storageKey);
      if (stored != null) return stored === "true";
      return datasetDefault;
    };
    const resolveEnumOption = (storageKey, allowed, datasetDefault) => {
      const stored = localStorage.getItem(storageKey);
      if (stored != null && allowed.includes(stored)) return stored;
      return datasetDefault;
    };
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
      subtitleScanCache: new Map(),
      customTitle: "",
      customYear: "",
      customTag: "",
      searchMode: "keyword",
      queryTouched: false,
      titleCandidates: { source: "", list: [], index: 0 },
      excludedSubtitles: new Set(),
      cachedSubtitles: new Map(),
      subtitleAutoScanPending: false,
      localSeasonMode: false,
      modeTouched: false,
      modeInference: null,
      seasonMapping: null,
    };
    state.localSeasonMode = resolveBoolOption(STORAGE.localSeasonMode, DEFAULTS.localSeasonMode);
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
      let pathname;
      try {
        pathname = decodeURIComponent(location.pathname);
      } catch {
        pathname = location.pathname;
      }
      if (base && pathname.startsWith(base)) pathname = pathname.slice(base.length) || "/";
      if (!pathname.startsWith("/")) pathname = `/${pathname}`;
      return pathname || "/";
    };

    const currentFolderName = () => {
      const parts = currentOpenListPath().split("/").filter(Boolean);
      return parts.length ? parts[parts.length - 1] : "";
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

    const matchSubtitlesByEpisode = (videoName, subtitles) => {
      const videoEpisode = parseEpisodeName(videoName);
      if (!videoEpisode) return [];
      return subtitles.filter((sub) => {
        const subEpisode = parseEpisodeName(sub.name);
        if (!subEpisode) return false;
        const seasonMatch = subEpisode.hasExplicitSeason
          ? subEpisode.season === videoEpisode.season
          : true;
        return seasonMatch && subEpisode.episode === videoEpisode.episode;
      });
    };

    const findSubtitleFilesRecursive = async (videoName) => {
      const local = findSubtitleFilesFor(videoName);
      if (local.length) {
        const results = local.map((sub) => ({ name: sub.name, dir: state.currentPath, matchType: "same-name" }));
        return deduplicateSubtitlesByVersion(results);
      }

      const subdirs = state.entries.filter((entry) => entry.is_dir);
      if (!subdirs.length) return [];

      const videoEpisode = parseEpisodeName(videoName);
      if (!videoEpisode) return [];

      const results = [];
      const subdirEntriesList = await Promise.all(
        subdirs.map(async (dir) => {
          const subdirPath = joinPath(state.currentPath, dir.name);
          if (state.subtitleScanCache.has(subdirPath)) {
            return { dir: subdirPath, entries: state.subtitleScanCache.get(subdirPath) };
          }
          try {
            const data = await fsList(subdirPath);
            const entries = Array.isArray(data?.content) ? data.content : [];
            state.subtitleScanCache.set(subdirPath, entries);
            return { dir: subdirPath, entries };
          } catch (error) {
            return { dir: subdirPath, entries: [] };
          }
        })
      );

      for (const { dir, entries } of subdirEntriesList) {
        const subtitles = entries.filter(isSubtitle);
        if (!subtitles.length) continue;
        const matched = matchSubtitlesByEpisode(videoName, subtitles);
        for (const sub of matched) {
          const subEp = parseEpisodeName(sub.name);
          const matchType = subEp && !subEp.hasExplicitSeason ? "by-episode-no-season" : "by-episode";
          results.push({ name: sub.name, dir, matchType });
        }
      }
      return deduplicateSubtitlesByVersion(results);
    };

    // 扫描全部字幕（当前目录 + 所有子目录，不短路），用于预览和取消选中
    const scanAllSubtitles = async (videoName) => {
      const results = [];
      const local = findSubtitleFilesFor(videoName);
      for (const sub of local) results.push({ name: sub.name, dir: state.currentPath, matchType: "same-name" });
      const subdirs = state.entries.filter((entry) => entry.is_dir);
      const videoEpisode = parseEpisodeName(videoName);
      if (subdirs.length && videoEpisode) {
        let completedDirs = 0;
        const totalDirs = subdirs.length;
        const fetchOneDir = async (dir) => {
          const subdirPath = joinPath(state.currentPath, dir.name);
          let entries;
          if (state.subtitleScanCache.has(subdirPath)) {
            entries = state.subtitleScanCache.get(subdirPath);
          } else {
            try {
              const data = await fsList(subdirPath);
              entries = Array.isArray(data?.content) ? data.content : [];
              state.subtitleScanCache.set(subdirPath, entries);
            } catch (error) {
              entries = [];
            }
          }
          completedDirs += 1;
          setStatus(`扫描子目录字幕 (${completedDirs}/${totalDirs})...`);
          return { dir: subdirPath, entries };
        };
        const pool = new Map();
        const subdirResults = [];
        for (let i = 0; i < subdirs.length; i += 1) {
          const task = fetchOneDir(subdirs[i]).then((result) => { subdirResults.push(result); return i; });
          pool.set(i, task);
          while (pool.size >= state.tmdbConcurrencyLimit) {
            const done = await Promise.race(pool.values());
            pool.delete(done);
          }
        }
        await Promise.all(pool.values());
        for (const { dir, entries } of subdirResults) {
          const subtitles = entries.filter(isSubtitle);
          if (!subtitles.length) continue;
          const matched = matchSubtitlesByEpisode(videoName, subtitles);
          for (const sub of matched) {
            const subEp = parseEpisodeName(sub.name);
            const matchType = subEp && !subEp.hasExplicitSeason ? "by-episode-no-season" : "by-episode";
            results.push({ name: sub.name, dir, matchType });
          }
        }
      }
      return deduplicateSubtitlesByVersion(results);
    };

    const triggerBatchSubtitleScan = async (rows, plan) => {
      if (state.subtitleAutoScanPending) return;
      state.subtitleAutoScanPending = true;
      try {
        for (const row of rows) {
          const rp = plan.rows.find((item) => item.row === row);
          if (!rp || !rp.target?.videoName || rp.row.error) continue;
          if (state.cachedSubtitles.has(rp.sourceName)) continue;
          const subs = await scanAllSubtitles(rp.sourceName);
          state.cachedSubtitles.set(rp.sourceName, subs);
        }
      } finally {
        state.subtitleAutoScanPending = false;
        renderPreview();
      }
    };

    const triggerSingleSubtitleScan = async (sourceName) => {
      if (state.subtitleAutoScanPending) return;
      state.subtitleAutoScanPending = true;
      try {
        const subs = await scanAllSubtitles(sourceName);
        state.cachedSubtitles.set(sourceName, subs);
      } finally {
        state.subtitleAutoScanPending = false;
        renderPreview();
      }
    };

    // 获取生效字幕：优先用缓存（含子目录全量），否则 findSubtitleFilesRecursive；过滤排除项
    const getEffectiveSubtitles = async (videoSourceName) => {
      const cached = state.cachedSubtitles.get(videoSourceName);
      const subs = cached || (await findSubtitleFilesRecursive(videoSourceName));
      return subs.filter((sub) => !state.excludedSubtitles.has(`${sub.dir}::${sub.name}`));
    };

    const deduplicateSubtitlesByVersion = (subtitles) => {
      const groups = new Map();
      for (const sub of subtitles) {
        // 去重 key 同时包含目录与文件名（剔除紧随 episode 标记后的版本号），
        // 避免不同语言版本（如 .chs.ass + .cht.ass）或不同子目录下的同集字幕被错误合并
        const key = `${sub.dir || ""}/${sub.name}`
          .toLowerCase()
          .replace(/([se]\d{1,3})\s*v\d+/gi, "$1")
          .replace(/([se]\d{1,3})[._\s-]v\d+/gi, "$1");
        const existing = groups.get(key);
        if (!existing) {
          groups.set(key, sub);
          continue;
        }
        const existingVersion = parseEpisodeName(existing.name)?.version || 0;
        const currentVersion = parseEpisodeName(sub.name)?.version || 0;
        if (currentVersion > existingVersion) {
          groups.set(key, sub);
        }
      }
      return [...groups.values()];
    };

    const normalizeName = (name) => String(name || "").toLowerCase();

    const parseMovieName = (name) => {
      const base = basename(name).replace(/【/g, "[").replace(/】/g, "]").normalize("NFKC");
      const yearRe = /(?<=^|[.\s_\-[({])((?:19|20)\d{2})(?=$|[.\s_\-\])}])/g;
      const currentYear = new Date().getFullYear();
      const maxYear = currentYear + 2;
      let yearMatch = null;
      for (const m of base.matchAll(yearRe)) {
        const y = Number(m[1]);
        if (y >= 1900 && y <= maxYear) yearMatch = m;
      }
      const year = yearMatch ? yearMatch[1] : "";
      const beforeYear = yearMatch ? base.slice(0, yearMatch.index) : base;
      const title = beforeYear
        .replace(/\[[^\]]*]/g, " ")
        .replace(/\([^)]*$/g, " ")
        .replace(/[._]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      // fallback：将方括号替换为内容+空格，避免返回未清理的原始 base
      // 否则 cleanTitleCandidate 会把方括号连同内容清空，导致 extractTitleCandidates 丢失该候选
      const fallbackTitle = base
        .replace(/\[([^\]]*)\]/g, " $1 ")
        .replace(/[._]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (!title && year) return { title: year, year: "" };
      return { title: title || fallbackTitle, year };
    };

    // 罗马数字季数解析（I=1..XX=20，超出范围返回 null）
    const parseRomanSeason = (s) => {
      const map = { I: 1, V: 5, X: 10, L: 50 };
      let n = 0;
      const upper = s.toUpperCase();
      for (let i = 0; i < upper.length; i++) {
        const cur = map[upper[i]];
        if (cur === undefined) return null;
        const next = map[upper[i + 1]];
        if (next && cur < next) { n += next - cur; i++; }
        else { n += cur; }
      }
      return n >= 1 && n <= 20 ? n : null;
    };

    // 从文本提取季数标记：S<数字> / X<数字> / Season <数字|罗马> / Part <数字|罗马>
    // 返回 { season, startIndex, endIndex } 或 null
    const extractSeasonFromText = (text) => {
      let m = text.match(/\b[SX]\s*(\d{1,2})\b/i);
      if (m) return { season: Number(m[1]), startIndex: m.index, endIndex: m.index + m[0].length };
      m = text.match(/第\s*(\d{1,2})\s*季/);
      if (m) return { season: Number(m[1]), startIndex: m.index, endIndex: m.index + m[0].length };
      m = text.match(/\b(?:Season|Part)\s*(\d{1,2})\b/i);
      if (m) return { season: Number(m[1]), startIndex: m.index, endIndex: m.index + m[0].length };
      m = text.match(/\b(?:Season|Part)\s*([IVXLCDM]+)\b/i);
      if (m) {
        const n = parseRomanSeason(m[1]);
        if (n) return { season: n, startIndex: m.index, endIndex: m.index + m[0].length };
      }
      // 4. 纯罗马数字（2 字符以上，避免单词 I 误匹配；优先级最低）
      m = text.match(/\b([IVXLCDM]{2,})\b/);
      if (m) {
        const n = parseRomanSeason(m[1]);
        if (n) return { season: n, startIndex: m.index, endIndex: m.index + m[0].length };
      }
      return null;
    };

    const parseEpisodeName = (name) => {
      const base = basename(name).replace(/【/g, "[").replace(/】/g, "]").normalize("NFKC");
      const multiEpisodeMatch = base.match(/\bS(\d{1,2})\s*E(\d{1,4})(?:\s*-?\s*E\s*(\d{1,4}))\b/i);
      if (multiEpisodeMatch) {
        const season = Number(multiEpisodeMatch[1]);
        const episode = Number(multiEpisodeMatch[2]);
        const episodeEnd = Number(multiEpisodeMatch[3]);
        const title = base
          .slice(0, multiEpisodeMatch.index)
          .replace(/\[[^\]]*]/g, " ")
          .replace(/[._-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return {
          season: Number.isFinite(season) && season >= 0 ? season : 1,
          episode,
          episodeEnd,
          title,
          hasExplicitSeason: true,
        };
      }
      const patterns = [
        /\bS(\d{1,2})\s*E(\d{1,4})(?:[.\s_-]?v(\d+))?\b/i,
        /\b(\d{1,2})x(\d{1,4})\b/i,
        /第\s*(\d{1,4})\s*[集话話]/i,
        /\bEP?\s*(\d{1,4})(?:v\d+)?\b/i,
      ];
      for (const pattern of patterns) {
        const match = base.match(pattern);
        if (!match) continue;
        const hasExplicitSeasonInPattern = match.length > 2;
        const season = hasExplicitSeasonInPattern ? Number(match[1]) : 1;
        const episode = Number(hasExplicitSeasonInPattern ? match[2] : match[1]);
        const version = match[3] ? Number(match[3]) : undefined;
        const titlePart = base.slice(0, match.index);
        const seasonFromText = extractSeasonFromText(titlePart);
        const finalSeason = hasExplicitSeasonInPattern ? season : (seasonFromText?.season ?? 1);
        const hasExplicitSeason = hasExplicitSeasonInPattern || !!seasonFromText;
        const title = titlePart
          .replace(/\[[^\]]*]/g, " ")
          .replace(/[._-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return {
          season: Number.isFinite(finalSeason) && finalSeason >= 0 ? finalSeason : 1,
          episode,
          title,
          version,
          hasExplicitSeason,
        };
      }

      // 模式 4.5：#NN 集数（井号格式），季数由 S<数字>/X<数字>/Season<数字|罗马> 提取
      const hashMatch = base.match(/#\s*(\d{1,4})(?:v(\d+))?\b/i);
      if (hashMatch) {
        const episode = Number(hashMatch[1]);
        const version = hashMatch[2] ? Number(hashMatch[2]) : undefined;
        const titlePart = base.slice(0, hashMatch.index);
        const seasonInfo = extractSeasonFromText(titlePart);
        const season = seasonInfo ? seasonInfo.season : 1;
        const title = titlePart
          .replace(/\[[^\]]*]/g, " ")
          .replace(CLEANUP_TECHNICAL_PATTERN, " ")
          .replace(/[._-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return {
          season: Number.isFinite(season) && season >= 0 ? season : 1,
          episode,
          title,
          version,
          hasExplicitSeason: !!seasonInfo,
        };
      }

      // 模式 5：方括号集数 [NN] / [NNvN] / [NN 标记] / [NNvN 标记]
      // 标记可为 END、Fin、Final、完结、最终回 等表示最后一集的任意词，季数由 X<数字> 标记提取
      // trailing 标记前必须有分隔符，避免 [1080P] 等技术标记误匹配
      const bracketMatch = base.match(/\[(\d{1,4})(?:v(\d+))?(?:[._\s-]+[^\]\[]+)?\]/i);
      if (bracketMatch) {
        const episode = Number(bracketMatch[1]);
        const version = bracketMatch[2] ? Number(bracketMatch[2]) : undefined;
        const titlePart = base.slice(0, bracketMatch.index);
        const seasonInfo = extractSeasonFromText(titlePart);
        const season = seasonInfo ? seasonInfo.season : 1;
        const title = titlePart
          .replace(/\[([^\]]*)\]/g, " $1 ")
          .replace(CLEANUP_TECHNICAL_PATTERN, " ")
          .replace(/[._-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return {
          season: Number.isFinite(season) && season >= 0 ? season : 1,
          episode,
          title,
          version,
          hasExplicitSeason: !!seasonInfo,
        };
      }

      // 模式 5.5：日期式命名 YYYY.MM.DD / YYYY-MM-DD / YYYY_MM_DD
      const dateMatch = base.match(/(\d{4})[._-](0[1-9]|1[0-2])[._-](0[1-9]|[12]\d|3[01])/);
      if (dateMatch) {
        const titlePart = base.slice(0, dateMatch.index);
        const seasonInfo = extractSeasonFromText(titlePart);
        const season = seasonInfo ? seasonInfo.season : 1;
        const title = titlePart
          .replace(/\[[^\]]*]/g, " ")
          .replace(CLEANUP_TECHNICAL_PATTERN, " ")
          .replace(/[._-]+/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        return {
          season: Number.isFinite(season) && season >= 0 ? season : 1,
          episode: 0,
          title,
          date: `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`,
          hasExplicitSeason: !!seasonInfo,
        };
      }

      // 模式 6：独立数字，季数由 X<数字> 标记提取
      const stripped = base
        .replace(/\([^)]*\)/g, " ")
        .replace(/\[[^\]]*]/g, " ")
        .replace(CLEANUP_TECHNICAL_PATTERN, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (stripped) {
        const seasonInfo = extractSeasonFromText(stripped);
        const season = seasonInfo ? seasonInfo.season : 1;
        const searchStart = seasonInfo ? seasonInfo.endIndex : 0;
        const searchText = stripped.slice(searchStart);
        const episodeMatch = searchText.match(/(?:^|[\s\-_.@#￥%&*])(\d{1,4})(?:v(\d+))?(?:[\s\-_.@#￥%&*]|$)/i);
        if (episodeMatch) {
          const episode = Number(episodeMatch[1]);
          if (episode >= 1000 && /^(19|20)\d{2}$/.test(episodeMatch[1])) {
            // skip 4-digit year-like numbers
          } else if ([360, 480, 576, 720, 1080, 1440, 2160, 4320].includes(episode)) {
            // skip resolution-like numbers
          } else {
            const version = episodeMatch[2] ? Number(episodeMatch[2]) : undefined;
            const titleEnd = seasonInfo ? seasonInfo.startIndex : searchStart + episodeMatch.index;
            const title = stripped
              .slice(0, titleEnd)
              .replace(/[._-]+/g, " ")
              .replace(/\s+/g, " ")
              .trim();
            return {
              season: Number.isFinite(season) && season >= 0 ? season : 1,
              episode,
              title,
              version,
              hasExplicitSeason: !!seasonInfo,
            };
          }
        }
      }

      return null;
    };

    const CLEANUP_TECHNICAL_PATTERN = /\b(?:4320p|2160p|1080p|720p|576p|480p|360p|4k|8k|uhd|sdr|web[ ._-]?dl|webrip|bluray|bdrip|bdremux|brrip|dvdrip|hdrip|hdtv|remux|x26[45]|h[ .]?26[45]|hevc|avc|av1|hi10p|hi444pp|10bit|12bit|60fps|hdr10\+?|hdr|dolby[ ._-]?vision|dv|dvhe|dvav|aac(?:[ .]?\d[ .]\d)?|ddp?(?:[ .]?\d[ .]\d)?|dts(?:[ ._-]?hd)?|truehd|atmos|flac|ac3)\b/gi;
    const CLEANUP_AD_PATTERN = /(?:更多(?:高清)?资源|关注(?:微信公众号|公众号)|扫码(?:关注|下载)?|加入?\s*(?:qq|q)?群|网盘资源|本站(?:专用|发布)|资源分享|分享群)/gi;
    const CLEANUP_DOMAIN_PATTERN = /\b(?:www\.)?[a-z0-9][a-z0-9-]*\.(?:com|cn|net|org)\b/gi;
    const CLEANUP_BRACKET_AD_PATTERN = /(?:www\.|https?:|\.(?:com|cn|net|org)\b|公众号|字幕组|压制组|发布组|资源|广告|网盘|qq\s*群|q群|微信|扫码|更多)/i;
    const containsCleanupTechnicalTag = (value) => {
      CLEANUP_TECHNICAL_PATTERN.lastIndex = 0;
      const matches = CLEANUP_TECHNICAL_PATTERN.test(value);
      CLEANUP_TECHNICAL_PATTERN.lastIndex = 0;
      return matches;
    };

    const TITLE_RESIDUE_PATTERNS = [
      /\[[^\]]*]/g,
      /\([^)]*\)/g,
      CLEANUP_TECHNICAL_PATTERN,
      /\b(?:10|12|8)-?bit\b/gi,
      /\bma\d+p\b/gi,
      /\bS\d{1,2}\s*E\d{1,4}(?:[.\s_-]?v\d+)?\b/gi,
      /\bEP?\s*\d{1,4}\b/gi,
      /\b第\s*\d{1,4}\s*[集话話]\b/gi,
      /\b第\s*\d{1,2}\s*季\b/gi,
      /\bEpisode\s*\d{1,4}\b/gi,
      /\bSeason\s*\d{1,2}\b/gi,
    ];

    const cleanTitleCandidate = (title) => {
      let s = String(title || "");
      for (const pattern of TITLE_RESIDUE_PATTERNS) {
        s = s.replace(pattern, " ");
      }
      s = s.replace(/[._]+/g, " ").replace(/\s+/g, " ").trim();
      return s;
    };

    // 检测是否含 CJK 字符（中文/日文/韩文）
    const containsCjk = (s) => /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(String(s || ""));

    // 将中英文混杂的标题按语种分段：连续的同语种词合并为一段，
    // 返回分段结果（仅当确实发生语种切换时才返回多段，否则返回空数组避免无意义重复）
    const splitTitleByLanguage = (text) => {
      const words = String(text || "").split(/\s+/).filter(Boolean);
      if (words.length < 2) return [];
      const segments = [];
      let current = [];
      let currentCjk = null;
      for (const word of words) {
        const isCjk = containsCjk(word);
        if (currentCjk === null) {
          currentCjk = isCjk;
          current = [word];
        } else if (isCjk === currentCjk) {
          current.push(word);
        } else {
          if (current.length) segments.push(current.join(" "));
          current = [word];
          currentCjk = isCjk;
        }
      }
      if (current.length) segments.push(current.join(" "));
      return segments.length > 1 ? segments : [];
    };

    const extractTitleCandidates = (name) => {
      const normalizedName = VIDEO_EXTS.has(extname(name)) ? name : `${name}.mkv`;
      const base = basename(normalizedName).replace(/【/g, "[").replace(/】/g, "]");
      const seen = new Set();
      // 候选至少需含一个字母（拉丁 / CJK），用于过滤纯标点 / 纯数字残留（如 "-"、"01-12"）
      const hasLetter = (s) => /[a-zA-Z\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(String(s || ""));
      const dedup = (cleaned) => {
        const key = cleaned.toLowerCase();
        if (cleaned && hasLetter(cleaned) && !seen.has(key)) {
          seen.add(key);
          return true;
        }
        return false;
      };
      // 主候选：parseEpisodeName / parseMovieName 提取的标题（保持原有排序与去重行为）
      const primary = [];
      const ep = parseEpisodeName(normalizedName);
      if (ep?.title) {
        const c = cleanTitleCandidate(ep.title);
        if (dedup(c)) primary.push(c);
      }
      const movie = parseMovieName(normalizedName);
      if (movie?.title) {
        const c = cleanTitleCandidate(movie.title);
        if (dedup(c)) primary.push(c);
      }
      primary.sort((a, b) => a.length - b.length);
      // 补充候选：方括号内容、括号外文本、中英文分段（追加在主候选之后，不影响首选项）
      // [xxx]yyy → xxx 与 yyy 各自独立；[xxx][yyy] → xxx 与 yyy 各自独立
      const extra = [];
      const pushExtra = (title) => {
        const c = cleanTitleCandidate(title);
        if (dedup(c)) extra.push(c);
      };
      const bracketRe = /\[([^\]]*)\]/g;
      let m;
      while ((m = bracketRe.exec(base)) !== null) {
        const content = m[1].trim();
        // 跳过集数标记：[01]、[01v2]、[12 END]、[01-12(全集)] 等
        // （数字开头 + 可选版本号 + 可选分隔符与后续标记词）
        if (/^\d{1,3}(?:v\d+)?(?:[._\s-]+[^\]\[]+)?$/.test(content)) continue;
        pushExtra(content);
      }
      pushExtra(base.replace(/\[[^\]]*\]/g, " "));
      // 中英文混杂时按语种分段，每段作为独立候选
      for (const candidate of [...primary, ...extra]) {
        for (const seg of splitTitleByLanguage(candidate)) pushExtra(seg);
      }
      extra.sort((a, b) => a.length - b.length);
      return [...primary, ...extra];
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

    const scoreSearchResult = (query, queryYear, item) => {
      const title = itemDisplayTitle(item).toLowerCase();
      const original = (state.mode === "tv" ? item.original_name : item.original_title || "").toLowerCase();
      const q = query.toLowerCase();
      const isCjk = /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(q);
      let titleScore = 0;
      if (isCjk) {
        if (title === q || original === q) titleScore = 100;
        else if (title.includes(q) || original.includes(q)) titleScore = 80;
        else if (q.includes(title) || q.includes(original)) titleScore = 60;
        else {
          const commonLen = [...q].filter((c) => title.includes(c) || original.includes(c)).length;
          titleScore = Math.round((commonLen / Math.max(q.length, 1)) * 50);
        }
      } else {
        const qTokens = q.split(/[\s._-]+/).filter(Boolean);
        const tTokens = title.split(/[\s._-]+/).filter(Boolean);
        const oTokens = original.split(/[\s._-]+/).filter(Boolean);
        const allTarget = new Set([...tTokens, ...oTokens]);
        const overlap = qTokens.filter((t) => allTarget.has(t)).length;
        titleScore = qTokens.length ? Math.round((overlap / qTokens.length) * 100) : 0;
      }
      let yearScore = 0;
      if (queryYear) {
        const itemYearStr = itemYear(item);
        if (itemYearStr === queryYear) yearScore = 20;
        else if (itemYearStr && Math.abs(Number(itemYearStr) - Number(queryYear)) <= 1) yearScore = 10;
      } else {
        yearScore = 5;
      }
      return titleScore + yearScore;
    };

    const SKELETON_DIGIT = "\x00";
    const buildSkeleton = (text) =>
      String(text || "")
        .replace(/\[[^\]]*]/g, " ")
        .replace(/\([^)]*\)/g, " ")
        .replace(CLEANUP_TECHNICAL_PATTERN, " ")
        .replace(/\d+/g, SKELETON_DIGIT)
        .replace(/[._]+/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const extractNumberTokens = (base) => {
      const tokens = [];
      const re = /\d+/g;
      let m;
      while ((m = re.exec(base)) !== null) {
        tokens.push({ value: m[0], start: m.index, end: m.index + m[0].length });
      }
      return tokens;
    };

    const RESOLUTION_NUMBERS = new Set([360, 480, 576, 720, 1080, 1440, 2160, 4320]);
    const isLikelyNonEpisodeNumber = (token) => {
      const n = Number(token);
      if (!Number.isFinite(n)) return true;
      if (RESOLUTION_NUMBERS.has(n)) return true;
      if (/^(19|20)\d{2}$/.test(token)) return true;
      return false;
    };

    const analyzeDirectoryStructure = (files) => {
      const parsed = files
        .map((file) => {
          const base = basename(file.name).replace(/【/g, "[").replace(/】/g, "]").normalize("NFKC");
          const result = parseEpisodeName(file.name);
          return { file, base, result, skeleton: buildSkeleton(base), tokens: extractNumberTokens(base) };
        })
        .filter((item) => item.skeleton);

      const groups = new Map();
      for (const item of parsed) {
        const arr = groups.get(item.skeleton) || [];
        arr.push(item);
        groups.set(item.skeleton, arr);
      }

      const analyses = [];
      for (const [, items] of groups) {
        if (items.length < 2) continue;
        const skeleton = items[0].skeleton;
        const tokenCount = items[0].tokens.length;

        const columns = [];
        for (let col = 0; col < tokenCount; col++) {
          const values = items
            .map((item) => item.tokens[col]?.value || null)
            .filter((v) => v != null);
          if (values.length === 0) continue;
          const uniqueValues = new Set(values);
          const uniqueRatio = uniqueValues.size / values.length;
          const allNumbers = values.every((v) => /^\d+$/.test(v));
          const nonEpisodeCount = values.filter((v) => isLikelyNonEpisodeNumber(v)).length;
          columns.push({
            index: col,
            values,
            uniqueCount: uniqueValues.size,
            uniqueRatio,
            allNumbers,
            nonEpisodeRatio: nonEpisodeCount / values.length,
          });
        }

        const seasonColumns = columns.filter((c) => c.allNumbers && c.uniqueRatio === 0 && c.nonEpisodeRatio === 0);
        const episodeColumns = columns.filter((c) => c.allNumbers && c.uniqueRatio >= 0.8 && c.nonEpisodeRatio < 0.3);

        const titlePrefixes = items.map((item) => {
          const firstColStart = columns[0]?.index != null ? item.tokens[columns[0].index]?.start : item.base.length;
          return item.base.slice(0, firstColStart ?? item.base.length).replace(/[\s._-]+$/g, "").trim();
        });
        const prefixSet = new Set(titlePrefixes);
        const prefixConsistency = prefixSet.size <= 1 ? 1 : (items.length > 0 ? 1 - (prefixSet.size - 1) / items.length : 0);

        const episodeHitRate = items.filter((item) => item.result != null).length / items.length;
        const seasonMarkRate = items.filter((item) => item.result?.hasExplicitSeason).length / items.length;

        let episodeColumn = null;
        if (episodeColumns.length > 0) {
          episodeColumn = episodeColumns.slice().sort((a, b) => {
            if (b.uniqueRatio !== a.uniqueRatio) return b.uniqueRatio - a.uniqueRatio;
            return b.index - a.index;
          })[0];
        }
        const seasonColumn = seasonColumns.length > 0 ? seasonColumns[0] : null;

        let duplicatePairs = false;
        if (seasonColumn && episodeColumn) {
          const pairs = new Set();
          for (const item of items) {
            const sv = item.tokens[seasonColumn.index]?.value;
            const ev = item.tokens[episodeColumn.index]?.value;
            if (sv != null && ev != null) {
              const key = `${sv}-${ev}`;
              if (pairs.has(key)) { duplicatePairs = true; break; }
              pairs.add(key);
            }
          }
        }

        analyses.push({
          skeleton,
          itemCount: items.length,
          episodeHitRate,
          seasonMarkRate,
          prefixConsistency,
          seasonColumn,
          episodeColumn,
          duplicatePairs,
        });
      }

      return analyses;
    };

    const inferMode = (files) => {
      if (!files || files.length === 0) return "movie";
      const analyses = analyzeDirectoryStructure(files);
      if (analyses.length === 0) {
        return files.length > 5 ? "tv" : "movie";
      }
      const totalFiles = analyses.reduce((sum, a) => sum + a.itemCount, 0);
      let totalEpisodeHit = 0;
      let totalSeasonMark = 0;
      let totalConsistency = 0;
      let hasValidEpisodeColumn = false;
      let hasDuplicatePairs = false;
      for (const a of analyses) {
        totalEpisodeHit += a.episodeHitRate * a.itemCount;
        totalSeasonMark += a.seasonMarkRate * a.itemCount;
        totalConsistency += a.prefixConsistency * a.itemCount;
        if (a.episodeColumn && !a.duplicatePairs) hasValidEpisodeColumn = true;
        if (a.duplicatePairs) hasDuplicatePairs = true;
      }
      const avgEpisodeHit = totalEpisodeHit / totalFiles;
      const avgSeasonMark = totalSeasonMark / totalFiles;
      const avgConsistency = totalConsistency / totalFiles;
      const fileCountScore = totalFiles > 5 ? 1 : 0;

      const score = avgEpisodeHit * 3 + avgSeasonMark * 2 + avgConsistency * 2 + fileCountScore;
      const reasons = [];
      if (avgEpisodeHit > 0) reasons.push(`集数命中率 ${(avgEpisodeHit * 100).toFixed(0)}%`);
      if (avgSeasonMark > 0) reasons.push(`季标记 ${(avgSeasonMark * 100).toFixed(0)}%`);
      if (avgConsistency > 0) reasons.push(`系列一致性 ${(avgConsistency * 100).toFixed(0)}%`);
      if (fileCountScore) reasons.push(`文件数 ${totalFiles}`);

      const result = {
        mode: score >= 4 ? "tv" : "movie",
        score,
        reasons,
        borderline: score >= 2 && score < 4,
        hasValidEpisodeColumn,
        hasDuplicatePairs,
      };
      state.modeInference = result;
      return result.mode;
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

    const effectiveTitle = (item) =>
      state.customTitle.trim() || itemDisplayTitle(item);

    const effectiveYear = (item) =>
      state.customYear.trim() || itemYear(item);

    const positiveNumber = (value) => {
      if (value == null) return undefined;
      const trimmed = String(value).trim();
      if (trimmed === "") return undefined;
      const number = Number(trimmed);
      return Number.isInteger(number) && number >= 0 ? number : undefined;
    };

    const tvEpisodeCode = (season, episode) =>
      `S${String(season ?? 1).padStart(2, "0")}E${String(episode ?? 0).padStart(2, "0")}`;

    const formatSeasonDir = (season, format) => {
      const n = Number(season ?? 1);
      const safe = Number.isFinite(n) && n >= 0 ? n : 1;
      switch (format) {
        case "s-2digit":
          return `S${String(safe).padStart(2, "0")}`;
        case "season-1digit":
          return `Season ${safe}`;
        case "season-2digit":
        default:
          return `Season ${String(safe).padStart(2, "0")}`;
      }
    };

    const tmdbIdTag = (item, enabled) => {
      if (!enabled || !item?.id) return "";
      return ` [tmdbid-${item.id}]`;
    };

    // 根据"嵌入 TMDB ID"总开关与文件模式，判断是否为视频/字幕文件嵌入 TMDB ID 标签
    // 文件夹始终遵循 embedTmdbId 总开关（structuringShowDir 直接使用）；
    // 文件是否嵌入由 tmdbIdFileMode 与当前模式（movie/tv）共同决定：
    //   files-both        -> 电影+电视剧文件均嵌入
    //   files-neither     -> 仅文件夹，文件均不嵌入
    //   files-movie-only  -> 仅电影文件嵌入
    //   files-tv-only     -> 仅电视剧文件嵌入
    const shouldEmbedTmdbIdInFile = (options, currentMode) => {
      if (!options.embedTmdbId) return false;
      switch (options.tmdbIdFileMode) {
        case "files-neither": return false;
        case "files-movie-only": return currentMode === "movie";
        case "files-tv-only": return currentMode === "tv";
        case "files-both":
        default: return true;
      }
    };

    const tvEpisodeBaseName = (show, episode, season, episodeNumber, options = namingOptions()) => {
      const title = safeFilePart(effectiveTitle(show));
      const code = tvEpisodeCode(season, episodeNumber);
      const parts = [title, code];
      if (options.includeEpisodeTitle) {
        const episodeTitle = safeFilePart(episode?.name || "");
        if (episodeTitle) parts.push(episodeTitle);
      }
      let base = parts.join(" - ");
      if (shouldEmbedTmdbIdInFile(options, "tv")) base += tmdbIdTag(show, true);
      return base;
    };

    // 语言代码 → 中文名映射（ISO 639-1）
    const LANG_NAME_MAP = {
      ja: "日语", zh: "中文", cn: "中文", en: "英语",
      ko: "韩语", fr: "法语", de: "德语", es: "西班牙语",
      it: "意大利语", ru: "俄语", th: "泰语", pt: "葡萄牙语",
      ar: "阿拉伯语", hi: "印地语", vi: "越南语", id: "印尼语",
      pl: "波兰语", nl: "荷兰语", sv: "瑞典语", tr: "土耳其语",
    };
    const langName = (code) => (code ? LANG_NAME_MAP[code] || code : "");

    // 选中条目后展示季信息（原始语言 + 季列表），仅 TV 模式
    const renderSeasonInfo = () => {
      const item = state.selectedItem;
      if (!item || state.mode !== "tv") return "";
      const id = item.id;
      const showUrl = `https://www.themoviedb.org/tv/${id}`;
      const lang = item.original_language
        ? `${langName(item.original_language)} (${item.original_language})`
        : "未知";
      const seasonLinkHtml = (url) =>
        `<a class="ol-tmdb-result-link" href="${url}" target="_blank" rel="noopener noreferrer" title="在 TMDB 打开" aria-label="在 TMDB 打开"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg></a>`;
      const seasons = (item.seasons || [])
        .slice()
        .sort((a, b) => (a.season_number ?? 0) - (b.season_number ?? 0))
        .map((s) => {
          const num = s.season_number ?? 0;
          const count = s.episode_count ?? 0;
          const rawName = (s.name || "").trim();
          const meaningful = rawName && !/^Season\s+\d+$/i.test(rawName);
          const name = meaningful ? ` ${escapeHtml(rawName)}` : "";
          if (num === 0) return `<div class="ol-tmdb-season-item">第 0 季：${name} (${count}集·特别篇)${seasonLinkHtml(`${showUrl}/season/${num}`)}</div>`;
          return `<div class="ol-tmdb-season-item">第 ${num} 季：${name} (${count}集)${seasonLinkHtml(`${showUrl}/season/${num}`)}</div>`;
        })
        .join("");
      const doubanUrl = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(itemDisplayTitle(item))}&cat=1002`;
      return `<div class="ol-tmdb-season-lang"><strong>原始语言：</strong> ${escapeHtml(lang)}${seasonLinkHtml(showUrl)}<a class="ol-tmdb-result-link ol-tmdb-douban-search-link" href="${escapeHtml(doubanUrl)}" target="_blank" rel="noopener noreferrer" title="在豆瓣搜索" aria-label="在豆瓣搜索">豆</a></div><div class="ol-tmdb-season-list">${seasons}</div>`;
    };

    const renderFolderStructurePreview = () => {
      if (!state.selectedItem) return "";
      const structuringEnabled = Boolean($(".ol-tmdb-do-structuring")?.checked);
      if (!structuringEnabled) return "";
      const showDir = structuringShowDir();
      if (!showDir) return "";
      const showName = showDir.split("/").pop() || showDir;
      let seasonDirs = [];
      if (state.mode === "tv") {
        if (isTvBatchActive()) {
          const seasonSet = new Set();
          state.tvBatchRows.forEach((row) => {
            const s = positiveNumber(row.mappedSeason) ?? positiveNumber(row.season);
            if (s != null) seasonSet.add(s);
          });
          seasonDirs = [...seasonSet].sort((a, b) => a - b).map((s) => structuringSeasonDir(s));
        } else {
          seasonDirs = [structuringTargetDir()];
        }
      }
      const tree = seasonDirs.length
        ? seasonDirs.map((dir, i) => {
          const name = dir.split("/").pop() || dir;
          const branch = i === seasonDirs.length - 1 ? "└─" : "├─";
          return `<div class="ol-tmdb-folder-tree-item"><span class="ol-tmdb-folder-branch">${branch}</span><span class="ol-tmdb-code">${escapeHtml(name)}/</span></div>`;
        }).join("")
        : "";
      return `<div class="ol-tmdb-folder-structure-head"><strong>文件夹结构预览</strong></div><div class="ol-tmdb-folder-tree"><div class="ol-tmdb-folder-tree-item ol-tmdb-folder-root"><span class="ol-tmdb-folder-icon">📂</span><span class="ol-tmdb-code">${escapeHtml(showName)}/</span></div>${tree}</div>`;
    };

    const targetBaseName = () => {
      if (!state.selectedItem) return "";
      const options = namingOptions();
      const title = safeFilePart(effectiveTitle(state.selectedItem));
      const year = effectiveYear(state.selectedItem);
      if (state.mode === "tv") {
        const season = positiveNumber($(".ol-tmdb-season")?.value) ?? 1;
        const episode = positiveNumber($(".ol-tmdb-episode")?.value);
        return tvEpisodeBaseName(state.selectedItem, state.selectedEpisode, season, episode, options);
      }
      const yearPart = options.includeYear && year ? ` (${year})` : "";
      const customTag = safeFilePart(state.customTag.trim());
      const tagPart = customTag ? ` - ${customTag}` : "";
      const idTag = tmdbIdTag(state.selectedItem, shouldEmbedTmdbIdInFile(options, "movie"));
      return `${title}${yearPart}${idTag}${tagPart}`;
    };

    const targetVideoName = () => {
      const file = selectedFile();
      if (!file || !state.selectedItem) return "";
      return `${targetBaseName()}.${extname(file.name)}`;
    };

    const structuringShowDir = () => {
      if (!state.selectedItem) return "";
      const options = namingOptions();
      const title = safeFilePart(effectiveTitle(state.selectedItem));
      const year = effectiveYear(state.selectedItem);
      const yearPart = options.includeYear && year ? ` (${year})` : "";
      const idTag = tmdbIdTag(state.selectedItem, options.embedTmdbId);
      const dirName = `${title}${yearPart}${idTag}`;
      return joinPath(state.currentPath, dirName);
    };

    const structuringTargetDir = () => {
      const showDir = structuringShowDir();
      if (!showDir) return "";
      if (state.mode === "tv") {
        const options = namingOptions();
        const season = positiveNumber($(".ol-tmdb-season")?.value) ?? 1;
        return joinPath(showDir, formatSeasonDir(season, options.seasonDirFormat));
      }
      return showDir;
    };

    const structuringSeasonDir = (season) => {
      const showDir = structuringShowDir();
      if (!showDir) return "";
      const options = namingOptions();
      return joinPath(showDir, formatSeasonDir(season, options.seasonDirFormat));
    };

    // 字幕语言后缀标准化映射（大小写不敏感）
    // 单语言：sc/chs→zh-Hans, tc/cht→zh-Hant, jp/jpn→ja
    // 中日双语组合（顺序无关，& / _ / 直接拼接均可）：
    //   简中+日文→zh-Hans.scjp, 繁中+日文→zh-Hant.tcjp
    const LANG_SINGLE_MAP = {
      sc: "zh-Hans", chs: "zh-Hans",
      tc: "zh-Hant", cht: "zh-Hant",
      jp: "ja",      jpn: "ja",
      en: "en",      eng: "en",
      kr: "ko",      kor: "ko",
    };

    const isCnSimplified = (t) => t === "sc" || t === "chs";
    const isCnTraditional = (t) => t === "tc" || t === "cht";
    const isCn = (t) => isCnSimplified(t) || isCnTraditional(t);
    const isJp = (t) => t === "jp" || t === "jpn";
    const isEn = (t) => t === "en" || t === "eng";
    const isKr = (t) => t === "kr" || t === "kor";
    const cnBcp47 = (t) => isCnSimplified(t) ? "zh-Hans" : "zh-Hant";
    const cnShort = (t) => isCnSimplified(t) ? "sc" : "tc";

    const normalizeLangTag = (tag) => {
      if (!tag) return "";
      const lower = String(tag).toLowerCase();
      // 1. 单语言直接映射
      if (LANG_SINGLE_MAP[lower]) return LANG_SINGLE_MAP[lower];
      // 2. 拼接型双语（无分隔符）
      //    中日：scjp / jpsc / tcjp / jptc
      //    简繁：sctc / tcsc / chscht / chtchs
      //    中英：scen / ens c / tcen / entc
      //    中韩：sckr / krsc / tckr / krtc
      const concatMatch = lower.match(
        /^(?:(sc|chs|tc|cht)(jp|jpn|en|eng|kr|kor|sc|chs|tc|cht)|(jp|jpn|en|eng|kr|kor)(sc|chs|tc|cht))$/,
      );
      if (concatMatch) {
        const left = concatMatch[1] || "";
        const right = concatMatch[2] || "";
        const rightAlt = concatMatch[3] || "";
        const leftAlt = concatMatch[4] || "";
        const cn = isCn(left) ? left : isCn(right) ? right : isCn(leftAlt) ? leftAlt : rightAlt;
        const other = isCn(left) ? right : isCn(right) ? left : isCn(leftAlt) ? rightAlt : leftAlt;
        if (isCn(other)) {
          return `zh-Hans.sctc`;
        }
        if (isJp(other)) return `${cnBcp47(cn)}.${cnShort(cn)}jp`;
        if (isEn(other)) return `${cnBcp47(cn)}.${cnShort(cn)}en`;
        if (isKr(other)) return `${cnBcp47(cn)}.${cnShort(cn)}kr`;
      }
      // 3. & 或 _ 分隔型双语/多语
      const parts = lower.split(/[&_]/).map((s) => s.trim()).filter(Boolean);
      if (parts.length >= 2) {
        const cnPart = parts.find(isCn);
        const jpPart = parts.find(isJp);
        const enPart = parts.find(isEn);
        const krPart = parts.find(isKr);
        if (cnPart) {
          const bcp = cnBcp47(cnPart);
          const sh = cnShort(cnPart);
          const otherCn = parts.filter((p) => isCn(p) && p !== cnPart);
          let suffix;
          if (otherCn.length) {
            suffix = "sctc";
            return `zh-Hans.${suffix}`;
          } else if (jpPart) {
            suffix = `${sh}jp`;
          } else if (enPart) {
            suffix = `${sh}en`;
          } else if (krPart) {
            suffix = `${sh}kr`;
          } else {
            suffix = sh;
          }
          return `${bcp}.${suffix}`;
        }
        if (jpPart && (enPart || krPart)) {
          return enPart ? "ja.jaen" : "ja.jakr";
        }
      }
      // 4. 不匹配，原样返回
      return tag;
    };

    const getSubtitleSuffixStrategy = () => {
      const select = $(".ol-tmdb-subtitle-suffix-strategy");
      if (select && SUBTITLE_SUFFIX_STRATEGIES.includes(select.value)) return select.value;
      return resolveEnumOption(STORAGE.subtitleSuffixStrategy, SUBTITLE_SUFFIX_STRATEGIES, DEFAULTS.subtitleSuffixStrategy);
    };

    const isLocalSeasonMode = () => state.localSeasonMode;

    const isLangSegment = (seg) => {
      if (/^\d+(\.\d+)?$/.test(seg)) return false;
      const normalized = normalizeLangTag(seg);
      return normalized !== seg || LANG_SINGLE_MAP[seg.toLowerCase()];
    };

    const normalizeSubtitleSuffix = (suffix, strategy) => {
      const segs = suffix.replace(/^\./, "").split(".").filter(Boolean);
      if (strategy === "ext-only") return "";
      if (strategy === "original") return segs.join(".");
      const filtered = segs.filter((seg) => {
        if (strategy === "lang-only") return isLangSegment(seg);
        return true;
      });
      return filtered.map((seg) => isLangSegment(seg) ? normalizeLangTag(seg) : seg).join(".");
    };

    const subtitleTargetName = (originalVideoName, targetVideoName, subtitleName) => {
      const strategy = getSubtitleSuffixStrategy();
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
        const normalized = normalizeSubtitleSuffix(suffix, strategy);
        return `${targetVideoBase}${normalized ? `.${normalized}` : ""}.${subExt}`;
      }
      let suffixStart = -1;
      for (let i = 0; i <= subBase.length - originalVideoBase.length; i++) {
        if (normalizeName(subBase.slice(i, i + originalVideoBase.length)) === videoBaseLower) {
          const after = subBase.slice(i + originalVideoBase.length);
          if (after === "" || after.startsWith(".")) {
            suffixStart = i + originalVideoBase.length;
            break;
          }
        }
      }
      if (suffixStart >= 0) {
        const suffix = subBase.slice(suffixStart);
        const normalized = normalizeSubtitleSuffix(suffix, strategy);
        return `${targetVideoBase}${normalized ? `.${normalized}` : ""}.${subExt}`;
      }
      let commonLen = 0;
      const minLen = Math.min(videoBaseLower.length, subBaseLower.length);
      for (let i = 0; i < minLen; i++) {
        if (videoBaseLower[i] !== subBaseLower[i]) break;
        commonLen = i + 1;
      }
      if (commonLen >= videoBaseLower.length * 0.5) {
        const remainder = subBase.slice(commonLen);
        const cleaned = remainder.replace(/[\]\)]+/g, ".").replace(/\.+/g, ".").replace(/^\./, "");
        if (cleaned) {
          const normalized = normalizeSubtitleSuffix(`.${cleaned}`, strategy);
          return `${targetVideoBase}${normalized ? `.${normalized}` : ""}.${subExt}`;
        }
      }
      const lastDotIdx = subBase.lastIndexOf(".");
      const suffix = lastDotIdx > 0 ? subBase.slice(lastDotIdx) : "";
      const normalized = normalizeSubtitleSuffix(suffix, strategy);
      return `${targetVideoBase}${normalized ? `.${normalized}` : ""}.${subExt}`;
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
      state.duplicateReport = null;
      state.executionReport = null;
      state.write = false;
      state.writeContentBypass = false;
      state.subtitleScanCache = new Map();
      state.excludedSubtitles = new Set();
      state.cachedSubtitles = new Map();
      state.customTitle = "";
      state.customYear = "";
      state.customTag = "";
      hideTitleCandidateList();
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

    const namingOptions = () => {
      const defaults = datasetDefaults();
      const boolFromDom = (selector, storageKey, defaultKey) => {
        const input = $(selector);
        if (input) return Boolean(input.checked);
        return resolveBoolOption(storageKey, defaults[defaultKey]);
      };
      const seasonSelect = $(".ol-tmdb-season-dir-format");
      const seasonFormat = seasonSelect
        ? (SEASON_DIR_FORMATS.includes(seasonSelect.value) ? seasonSelect.value : defaults.seasonDirFormat)
        : resolveEnumOption(STORAGE.seasonDirFormat, SEASON_DIR_FORMATS, defaults.seasonDirFormat);
      const tmdbIdModeSelect = $(".ol-tmdb-tmdb-id-mode");
      const tmdbIdFileMode = tmdbIdModeSelect
        ? (TMDB_ID_FILE_MODES.includes(tmdbIdModeSelect.value) ? tmdbIdModeSelect.value : defaults.tmdbIdFileMode)
        : resolveEnumOption(STORAGE.tmdbIdFileMode, TMDB_ID_FILE_MODES, defaults.tmdbIdFileMode);
      return {
        includeEpisodeTitle: boolFromDom(".ol-tmdb-include-episode-title", STORAGE.includeEpisodeTitle, "includeEpisodeTitle"),
        embedTmdbId: boolFromDom(".ol-tmdb-embed-tmdb-id", STORAGE.embedTmdbId, "embedTmdbId"),
        tmdbIdFileMode,
        includeYear: boolFromDom(".ol-tmdb-include-year", STORAGE.includeYear, "includeYear"),
        seasonDirFormat: seasonFormat,
      };
    };

    const noAvailableActionMessage = () => {
      const capabilities = operationCapabilities();
      return !capabilities.rename && !capabilities.structuring
        ? "当前权限仅允许只读操作；仍可搜索和预览"
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

    // 复制文本到剪贴板：优先 Clipboard API，失败回退 execCommand；返回是否成功
    const copyTextToClipboard = async (text) => {
      if (!text) return false;
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        try {
          const textarea = document.createElement("textarea");
          textarea.value = text;
          textarea.style.position = "fixed";
          textarea.style.opacity = "0";
          document.body.appendChild(textarea);
          textarea.select();
          document.execCommand("copy");
          textarea.remove();
          return true;
        } catch {
          return false;
        }
      }
    };

    const copyExecutionReport = async () => {
      const text = executionReportText(state.executionReport);
      if (!text) return;
      const ok = await copyTextToClipboard(text);
      setStatus(ok ? "失败明细已复制" : "复制失败", ok ? "ok" : "error");
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
        <small>${escapeHtml(permissionNote)}；TMDB 搜索和预览始终可用。</small>
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
      state._tmdbSuccessStreak = 0;
    };

    const noteTmdbSuccess = () => {
      if (!state.tmdbRateLimited) return;
      state._tmdbSuccessStreak = (state._tmdbSuccessStreak || 0) + 1;
      if (state._tmdbSuccessStreak >= 10) {
        state._tmdbSuccessStreak = 0;
        state.tmdbConcurrency = Math.min(state.tmdbConcurrency + 1, state.tmdbConcurrencyLimit);
        if (state.tmdbConcurrency >= state.tmdbConcurrencyLimit) {
          state.tmdbRateLimited = false;
        }
      }
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
              else if (result.ok) noteTmdbSuccess();
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
      tmdbRequest(`/movie/${id}`);

    const getTvDetails = async (id) =>
      tmdbRequest(`/tv/${id}`);

    const getTvSeason = async (id, seasonNumber) =>
      tmdbRequest(`/tv/${id}/season/${seasonNumber}`);

    const getTvEpisode = async (id, seasonNumber, episodeNumber) =>
      tmdbRequest(`/tv/${id}/season/${seasonNumber}/episode/${episodeNumber}`);

    const buildImageUrl = (path, size = "w185") =>
      path ? `https://image.tmdb.org/t/p/${size}${path}` : "";

    // 影视标签（类型）映射：tmdbRequest 已自带会话缓存，这里再缓存解析后的 id→name 表
    const genreMaps = { movie: null, tv: null };
    const fetchGenres = async (type) => {
      if (genreMaps[type]) return genreMaps[type];
      try {
        const data = await tmdbRequest(`/genre/${type}/list`);
        const map = {};
        (data.genres || []).forEach((g) => {
          map[g.id] = g.name;
        });
        genreMaps[type] = map;
        return map;
      } catch {
        return {};
      }
    };

    // 兼容两种来源：搜索结果用 genre_ids（数字数组），详情接口用 genres（{id,name} 数组）
    const itemGenres = (item) => {
      if (Array.isArray(item?.genres) && item.genres.length) {
        return item.genres.map((g) => g.name).filter(Boolean);
      }
      const map = genreMaps[state.mode] || {};
      return (item?.genre_ids || []).map((id) => map[id]).filter(Boolean);
    };

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
        const season = positiveNumber(previous?.season) ?? parsed?.season ?? "";
        const episode = positiveNumber(previous?.episode) ?? parsed?.episode ?? "";
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
          mappedSeason: sameEpisode ? previous.mappedSeason ?? null : null,
          mappedEpisode: sameEpisode ? previous.mappedEpisode ?? null : null,
          mappingSource: sameEpisode ? previous.mappingSource ?? null : null,
          midSeasonFinale: sameEpisode ? previous.midSeasonFinale ?? false : false,
        };
      });
    };

    const batchRowStatus = (row) => {
      if (positiveNumber(row.season) == null || positiveNumber(row.episode) == null) {
        return { text: "待填写季 / 集", kind: "error" };
      }
      if (row.error) return { text: row.error, kind: "error" };
      if (row.result) return { text: row.result, kind: "ok" };
      if (row.episodeDetails) return { text: "已匹配", kind: "ok" };
      if (isLocalSeasonMode()) return { text: "本地模式", kind: "ok" };
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
        .filter((item) => item.season != null && item.episode != null)
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
      season: positiveNumber(rows[0]?.season) ?? 1,
      episode: positiveNumber(rows[0]?.episode) ?? 1,
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
      const season = positiveNumber(row.mappedSeason) ?? positiveNumber(row.season);
      const episode = positiveNumber(row.mappedEpisode) ?? positiveNumber(row.episode);
      if (!file || !state.selectedItem || season == null || !episode) {
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
      const localMode = isLocalSeasonMode();
      const mkdirDirs = new Set();
      const rowPlans = state.tvBatchRows.map((row, index) => {
        const file = state.files.find((item) => item.name === row.name);
        const matchedTarget = batchRowTarget(row);
        if (!file || (!row.episodeDetails && !localMode) || !matchedTarget.videoName) {
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
          const season = positiveNumber(row.mappedSeason) ?? positiveNumber(row.season) ?? 1;
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
        if (!rowPlan.row.episodeDetails && !localMode) return;
        const ms = rowPlan.row.mappedSeason != null ? rowPlan.row.mappedSeason : positiveNumber(rowPlan.row.season);
        const me = rowPlan.row.mappedEpisode != null ? rowPlan.row.mappedEpisode : positiveNumber(rowPlan.row.episode);
        const key = `${ms}:${me}`;
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
      row[input.dataset.field] = positiveNumber(input.value) ?? "";
      row.episodeDetails = null;
      row.error = "";
      row.result = "";
      row.mappedSeason = null;
      row.mappedEpisode = null;
      row.mappingSource = null;
      row.midSeasonFinale = false;
    };

    const fillSequentialEpisodes = (season, firstEpisode) => {
      const normalizedSeason = positiveNumber(season);
      const normalizedEpisode = positiveNumber(firstEpisode);
      if (normalizedSeason == null || !normalizedEpisode) return false;
      state.tvBatchRows.forEach((row, index) => {
        row.season = normalizedSeason;
        row.episode = normalizedEpisode + index;
        row.episodeDetails = null;
        row.error = "";
        row.result = "";
        row.mappedSeason = null;
        row.mappedEpisode = null;
        row.mappingSource = null;
        row.midSeasonFinale = false;
      });
      return true;
    };

    const bindBatchOverviewActions = (preview) => {
      $(".ol-tmdb-fill-sequential", preview)?.addEventListener("click", async () => {
        const season = $(".ol-tmdb-fill-season", preview)?.value;
        const episode = $(".ol-tmdb-fill-episode", preview)?.value;
        if (!fillSequentialEpisodes(season, episode)) {
          setStatus("连续填充需要有效的季和起始集", "error");
          return;
        }
        // 连续填充后自动更新逐集预览
        await hydrateTvBatchEpisodes();
      });
    };

    const MID_SEASON_FINALE_KEYWORDS = /mid[- ]?season|part[- ]?finale|midfinale|中结局|季中结局|季中完结/i;

    const gcd = (a, b) => {
      a = Math.abs(a); b = Math.abs(b);
      while (b) { [a, b] = [b, a % b]; }
      return a;
    };

    const inferCourSize = (episodeCount, midFinalePositions) => {
      if (midFinalePositions.length > 0) {
        const allPositions = [...midFinalePositions, episodeCount];
        let g = allPositions[0];
        for (let i = 1; i < allPositions.length; i++) {
          g = gcd(g, allPositions[i]);
        }
        if (g >= 10 && g <= 26) return g;
      }
      for (const common of [12, 13, 24, 25, 26]) {
        if (episodeCount > common && episodeCount % common === 0) return common;
      }
      return episodeCount;
    };

    const splitIntoCours = (tmdbSeason, episodeCount, courSize, startIndex) => {
      if (courSize >= episodeCount) {
        return [{ index: startIndex, tmdbSeason, startEp: 1, endEp: episodeCount, size: episodeCount, assigned: false }];
      }
      const cours = [];
      let ep = 1;
      let idx = startIndex;
      while (ep <= episodeCount) {
        const endEp = Math.min(ep + courSize - 1, episodeCount);
        cours.push({ index: idx, tmdbSeason, startEp: ep, endEp, size: endEp - ep + 1, assigned: false });
        ep = endEp + 1;
        idx += 1;
      }
      return cours;
    };

    const buildSeasonMapping = async () => {
      const item = state.selectedItem;
      if (!item?.seasons) {
        state.seasonMapping = { mode: "direct", map: new Map(), summary: "" };
        return state.seasonMapping;
      }

      const localSeasonMap = new Map();
      for (const row of state.tvBatchRows) {
        const s = positiveNumber(row.season);
        if (s == null) continue;
        if (!localSeasonMap.has(s)) localSeasonMap.set(s, new Set());
        const e = positiveNumber(row.episode);
        if (e) localSeasonMap.get(s).add(e);
      }

      const localSeasons = [...localSeasonMap.keys()].sort((a, b) => a - b);
      if (localSeasons.length === 0) {
        state.seasonMapping = { mode: "direct", map: new Map(), summary: "" };
        return state.seasonMapping;
      }

      const tmdbSeasons = (item.seasons || [])
        .filter((s) => (s.season_number ?? 0) > 0)
        .sort((a, b) => (a.season_number ?? 0) - (b.season_number ?? 0));

      if (tmdbSeasons.length === 0) {
        state.seasonMapping = { mode: "direct", map: new Map(), summary: "" };
        return state.seasonMapping;
      }

      const tmdbByNumber = new Map(tmdbSeasons.map((s) => [s.season_number, s]));

      const tmdbRanges = [];
      let cumulative = 0;
      for (const s of tmdbSeasons) {
        const count = s.episode_count ?? 0;
        tmdbRanges.push({ season: s.season_number, start: cumulative + 1, end: cumulative + count, count });
        cumulative += count;
      }

      const map = new Map();
      let mode = "direct";
      const summaryParts = [];

      const hasUnmatchedLocalSeason = localSeasons.some((s) => !tmdbByNumber.has(s));
      let allCours = [];
      if (hasUnmatchedLocalSeason) {
        const tmdbSeasonDetails = new Map();
        for (const s of tmdbSeasons) {
          try {
            const data = await getTvSeason(item.id, s.season_number);
            tmdbSeasonDetails.set(s.season_number, data.episodes || []);
          } catch {
            tmdbSeasonDetails.set(s.season_number, []);
          }
        }
        let courIndex = 1;
        for (const s of tmdbSeasons) {
          const episodes = tmdbSeasonDetails.get(s.season_number) || [];
          const midFinalePositions = [];
          for (const ep of episodes) {
            if (MID_SEASON_FINALE_KEYWORDS.test(ep.name || "")) {
              midFinalePositions.push(ep.episode_number);
            }
          }
          const courSize = inferCourSize(s.episode_count || 0, midFinalePositions);
          const cours = splitIntoCours(s.season_number, s.episode_count || 0, courSize, courIndex);
          allCours.push(...cours);
          courIndex += cours.length;
        }
      }

      for (const localSeason of localSeasons) {
        const localEpisodes = [...localSeasonMap.get(localSeason)].sort((a, b) => a - b);
        const maxEp = localEpisodes[localEpisodes.length - 1] || 0;

        if (tmdbByNumber.has(localSeason)) {
          const tmdbData = tmdbByNumber.get(localSeason);
          const tmdbCount = tmdbData.episode_count ?? 0;

          if (maxEp <= tmdbCount) {
            map.set(localSeason, { tmdbSeason: localSeason, offset: 0, source: "tmdb", split: false });
          } else {
            map.set(localSeason, { tmdbSeason: null, offset: 0, source: "inferred", split: true, tmdbRanges });
            mode = "remap";
            summaryParts.push(`本地 S${localSeason} 超出 TMDB 范围 → 绝对编号切分`);
          }
        } else {
          let prevTmdbSeason = null;
          let prevOffset = 0;
          let prevLocalCount = 0;
          for (let i = localSeasons.indexOf(localSeason) - 1; i >= 0; i--) {
            const prev = map.get(localSeasons[i]);
            if (prev && prev.tmdbSeason != null) {
              prevTmdbSeason = prev.tmdbSeason;
              prevOffset = prev.offset;
              prevLocalCount = Math.max(0, ...localSeasonMap.get(localSeasons[i]));
              break;
            }
          }

          if (prevTmdbSeason != null) {
            const newOffset = prevOffset + prevLocalCount;
            const tmdbData = tmdbByNumber.get(prevTmdbSeason);
            const tmdbCount = tmdbData?.episode_count ?? 0;
            const totalNeeded = newOffset + maxEp;

            if (totalNeeded <= tmdbCount) {
              map.set(localSeason, { tmdbSeason: prevTmdbSeason, offset: newOffset, source: "inferred", split: false });
              mode = "remap";
              summaryParts.push(`本地 S${localSeason}E1-${maxEp} → TMDB S${prevTmdbSeason}E${newOffset + 1}-${newOffset + maxEp}`);
            } else {
              map.set(localSeason, { tmdbSeason: null, offset: 0, source: "local", split: false });
              summaryParts.push(`本地 S${localSeason} 无法映射（超出 TMDB S${prevTmdbSeason} 的 ${tmdbCount} 集）`);
            }
          } else {
            const matchedCour = allCours.find(c => c.index === localSeason && !c.assigned);
            if (matchedCour && Math.abs(maxEp - matchedCour.size) <= 1) {
              matchedCour.assigned = true;
              const offset = matchedCour.startEp - 1;
              map.set(localSeason, { tmdbSeason: matchedCour.tmdbSeason, offset, source: "inferred", split: false });
              mode = "remap";
              summaryParts.push(`本地 S${localSeason}E1-${maxEp} → TMDB S${matchedCour.tmdbSeason}E${matchedCour.startEp}-${matchedCour.endEp}（子季拆分）`);
            } else {
              const compatible = allCours.filter(c => !c.assigned && Math.abs(maxEp - c.size) <= 1);
              if (compatible.length > 0) {
                const best = compatible[0];
                best.assigned = true;
                const offset = best.startEp - 1;
                map.set(localSeason, { tmdbSeason: best.tmdbSeason, offset, source: "inferred", split: false });
                mode = "remap";
                summaryParts.push(`本地 S${localSeason}E1-${maxEp} → TMDB S${best.tmdbSeason}E${best.startEp}-${best.endEp}（子季兼容匹配）`);
              } else {
                map.set(localSeason, { tmdbSeason: null, offset: 0, source: "local", split: false });
                summaryParts.push(`本地 S${localSeason} 无对应 TMDB 季`);
              }
            }
          }
        }
      }

      state.seasonMapping = {
        mode,
        map,
        summary: summaryParts.join("；"),
        tmdbRanges,
        localSeasons: localSeasons.map((s) => ({ season: s, count: localSeasonMap.get(s).size })),
        tmdbSeasons: tmdbSeasons.map((s) => ({ season: s.season_number, count: s.episode_count })),
      };
      return state.seasonMapping;
    };

    const remapEpisode = (localSeason, localEpisode) => {
      const mapping = state.seasonMapping;
      if (!mapping || mapping.mode === "direct") {
        return { tmdbSeason: localSeason, tmdbEpisode: localEpisode, source: "tmdb" };
      }

      const entry = mapping.map.get(localSeason);
      if (!entry) {
        return { tmdbSeason: localSeason, tmdbEpisode: localEpisode, source: "local" };
      }

      if (entry.split && entry.tmdbRanges) {
        for (const range of entry.tmdbRanges) {
          if (localEpisode >= range.start && localEpisode <= range.end) {
            return {
              tmdbSeason: range.season,
              tmdbEpisode: localEpisode - range.start + 1,
              source: "inferred",
            };
          }
        }
        return { tmdbSeason: localSeason, tmdbEpisode: localEpisode, source: "local" };
      }

      return {
        tmdbSeason: entry.tmdbSeason,
        tmdbEpisode: localEpisode + entry.offset,
        source: entry.source,
      };
    };

    const fetchTvBatchEpisodes = async (rows = state.tvBatchRows) => {
      if (isLocalSeasonMode()) {
        state.seasonMapping = null;
        for (const row of rows) {
          row.result = "";
          row.episodeDetails = null;
          row.error = "";
          row.mappedSeason = null;
          row.mappedEpisode = null;
          row.mappingSource = null;
          row.midSeasonFinale = false;
        }
        return { success: rows.length, failed: 0, concurrency: state.tmdbConcurrency };
      }
      let success = 0;
      let failed = 0;

      await buildSeasonMapping();
      const mapping = state.seasonMapping;
      const needsRemap = mapping && mapping.mode === "remap";

      const validRows = [];
      for (const row of rows) {
        row.result = "";
        row.mappedSeason = null;
        row.mappedEpisode = null;
        row.mappingSource = null;
        row.midSeasonFinale = false;
        const season = positiveNumber(row.season);
        const episode = positiveNumber(row.episode);
        if (season == null || !episode) {
          row.episodeDetails = null;
          row.error = "请填写季 / 集";
          failed += 1;
        } else if (row.episodeDetails && !needsRemap) {
          success += 1;
        } else {
          if (needsRemap) {
            const remapped = remapEpisode(season, episode);
            row.mappedSeason = remapped.tmdbSeason;
            row.mappedEpisode = remapped.tmdbEpisode;
            row.mappingSource = remapped.source;
            row.episodeDetails = null;
            if (row.mappedSeason == null) {
              row.error = "本地季号无对应 TMDB 季";
              failed += 1;
              continue;
            }
          }
          validRows.push(row);
        }
      }

      if (validRows.length === 0) {
        return { success, failed, concurrency: state.tmdbConcurrency };
      }

      const seasonGroups = new Map();
      for (const row of validRows) {
        const fetchSeason = needsRemap && row.mappedSeason != null ? row.mappedSeason : positiveNumber(row.season);
        if (!seasonGroups.has(fetchSeason)) seasonGroups.set(fetchSeason, []);
        seasonGroups.get(fetchSeason).push(row);
      }

      const seasonEntries = [...seasonGroups.entries()];
      let completedSeasons = 0;
      const totalSeasons = seasonEntries.length;

      const fetchOneSeason = async ([season, seasonRows]) => {
        try {
          const data = await getTvSeason(state.selectedItem.id, season);
          const episodes = data.episodes || [];
          for (const row of seasonRows) {
            const episode = needsRemap && row.mappedEpisode != null ? row.mappedEpisode : positiveNumber(row.episode);
            const found = episodes.find((e) => e.episode_number === episode);
            if (found) {
              row.episodeDetails = found;
              row.error = "";
              row.midSeasonFinale = MID_SEASON_FINALE_KEYWORDS.test(found.name || "");
              success += 1;
            } else {
              row.episodeDetails = null;
              row.error = `第 ${season} 季第 ${episode} 集不存在`;
              failed += 1;
            }
          }
        } catch (error) {
          for (const row of seasonRows) {
            row.episodeDetails = null;
            row.error = error.message;
            failed += 1;
          }
        }
        completedSeasons += 1;
        setStatus(`正在读取季信息 (${completedSeasons}/${totalSeasons})...`);
      };

      const pool = new Map();
      for (let i = 0; i < seasonEntries.length; i += 1) {
        const task = fetchOneSeason(seasonEntries[i]).then(() => i);
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
        if (isLocalSeasonMode()) {
          state.seasonMapping = null;
          for (const row of state.tvBatchRows) {
            row.result = "";
            row.episodeDetails = null;
            row.error = "";
            row.mappedSeason = null;
            row.mappedEpisode = null;
            row.mappingSource = null;
            row.midSeasonFinale = false;
          }
          render();
          setStatus("本地模式，已跳过 TMDB 校验");
        } else {
          const result = await fetchTvBatchEpisodes();
          render();
          setStatus(
            result.failed
              ? `已更新 ${result.success} 集，${result.failed} 项需要修正${tmdbConcurrencyNotice()}`
              : `已更新 ${result.success} 集${tmdbConcurrencyNotice()}`,
            result.failed ? "error" : "ok",
          );
        }
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
          const preserveQuery = state.queryTouched;
          const savedQuery = preserveQuery ? $(".ol-tmdb-query")?.value ?? "" : "";
          hydrateSearchFromFile();
          if (preserveQuery) {
            const queryInput = $(".ol-tmdb-query");
            if (queryInput) queryInput.value = savedQuery;
          }
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
        .map((item, index) => {
          const title = itemDisplayTitle(item);
          const year = itemYear(item);
          const selected = state.selectedItem?.id === item.id;
          const poster = buildImageUrl(item.poster_path, "w154");
          const original = state.mode === "tv" ? item.original_name : item.original_title;
          const genres = itemGenres(item);
          const tagsHtml = genres.length
            ? `<div class="ol-tmdb-tags">${genres.map((g) => `<span class="ol-tmdb-tag">${escapeHtml(g)}</span>`).join("")}</div>`
            : "";
          const tmdbUrl = `https://www.themoviedb.org/${state.mode === "tv" ? "tv" : "movie"}/${item.id}${state.mode === "tv" ? "/seasons" : ""}`;
          const doubanSearchUrl = `https://search.douban.com/movie/subject_search?search_text=${encodeURIComponent(title)}&cat=1002`;
          const bestMatch = index === 0 && (item._score ?? 0) >= 60;
          return `<div class="ol-tmdb-result" role="button" tabindex="0" data-id="${item.id}" data-selected="${selected}">
            ${poster ? `<img class="ol-tmdb-poster" alt="" src="${escapeHtml(poster)}" loading="lazy">` : '<div class="ol-tmdb-poster"></div>'}
            <div>
              <div class="ol-tmdb-name" title="${escapeHtml(title)}">${escapeHtml(title)}${bestMatch ? ' <span class="ol-tmdb-best">最佳匹配</span>' : ""}</div>
              <div class="ol-tmdb-meta">${escapeHtml(year || "未知年份")} · ${escapeHtml((original || "").slice(0, 80))}</div>
              ${tagsHtml}
            </div>
            <div class="ol-tmdb-result-actions">
              <a class="ol-tmdb-result-link" href="${escapeHtml(tmdbUrl)}" target="_blank" rel="noopener noreferrer" title="在 TMDB 打开" aria-label="在 TMDB 打开">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
              </a>
              <a class="ol-tmdb-result-link ol-tmdb-douban-search-link" href="${escapeHtml(doubanSearchUrl)}" target="_blank" rel="noopener noreferrer" title="在豆瓣搜索" aria-label="在豆瓣搜索">豆</a>
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

    // 批量模式字幕预览区（按视频分组，带 checkbox 和来源标签）
    const renderBatchSubtitlePreview = (rows, plan, collapsed = false) => {
      const structuringEnabled = Boolean($(".ol-tmdb-do-structuring")?.checked);
      const allSubRows = [];
      for (const row of rows) {
        const rowPlan = plan.rows.find((item) => item.row === row);
        if (!rowPlan || !rowPlan.target?.videoName || rowPlan.row.error) continue;
        const sourceName = rowPlan.sourceName;
        const cached = state.cachedSubtitles.get(sourceName);
        const subs = cached
          ? cached
          : findSubtitleFilesFor(sourceName).map((sub) => ({ name: sub.name, dir: state.currentPath }));
        const seasonDir = structuringEnabled ? structuringSeasonDir(positiveNumber(row.mappedSeason) ?? positiveNumber(row.season) ?? 1) : "";
        for (const sub of subs) {
          const subTarget = subtitleTargetName(sourceName, rowPlan.target.videoName, sub.name);
          if (subTarget === sub.name) continue;
          const key = `${sub.dir}::${sub.name}`;
          const checked = state.excludedSubtitles.has(key) ? "" : "checked";
          const sourceLabel = sub.matchType === "same-name" ? "当前（同名）"
            : sub.matchType === "by-episode" ? `${sub.dir.replace(state.currentPath, "").replace(/^\//, "") || sub.dir}（按集）`
            : sub.matchType === "by-episode-no-season" ? `${sub.dir.replace(state.currentPath, "").replace(/^\//, "") || sub.dir}（按集·无季）`
            : sub.dir === state.currentPath ? "当前" : sub.dir.replace(state.currentPath, "").replace(/^\//, "") || sub.dir;
          const destDirDisplay = seasonDir.replace(state.currentPath, "").replace(/^\//, "") || seasonDir;
          const destDirHtml = seasonDir ? `<div class="ol-tmdb-sub-dest"><span class="ol-tmdb-sub-arrow">→</span><span class="ol-tmdb-code" title="${escapeHtml(seasonDir)}/">${escapeHtml(destDirDisplay)}/</span></div>` : "";
          allSubRows.push(`<div class="ol-tmdb-sub-row">
            <label class="ol-tmdb-sub-check"><input type="checkbox" ${checked} data-sub-key="${escapeHtml(key)}"><span class="ol-tmdb-code ol-tmdb-sub-source" title="${escapeHtml(sub.name)}">${escapeHtml(sub.name)}</span></label>
            <div class="ol-tmdb-sub-target"><span class="ol-tmdb-sub-arrow">→</span><span class="ol-tmdb-sub-src">${escapeHtml(sourceLabel)}</span><span class="ol-tmdb-code">${escapeHtml(subTarget)}</span></div>
            ${destDirHtml}
          </div>`);
        }
      }
      const hasCached = rows.some((row) => {
        const rp = plan.rows.find((item) => item.row === row);
        return rp && state.cachedSubtitles.has(rp.sourceName);
      });
      const scanText = hasCached ? "重新扫描全部字幕" : "扫描全部字幕";
      const subSummary = collapsed ? `<span class="ol-tmdb-meta">${allSubRows.length} 条字幕待改名</span>` : "";
      const autoScanChecked = resolveBoolOption(STORAGE.subtitleAutoScan, DEFAULTS.subtitleAutoScan) ? "checked" : "";
      return `<div class="ol-tmdb-subtitle-preview">
        <div class="ol-tmdb-sub-head"><strong>字幕改名</strong>${subSummary}<div class="ol-tmdb-sub-actions"><label class="ol-tmdb-auto-scan-label"><input class="ol-tmdb-auto-scan-subs" type="checkbox" ${autoScanChecked}> 自动扫描</label><button class="ol-tmdb-action ol-tmdb-scan-subs" type="button">${scanText}</button><button type="button" class="ol-tmdb-action ol-tmdb-collapse-toggle" data-target="sub" title="${collapsed ? "展开字幕预览" : "收起字幕预览"}">${collapsed ? "展开" : "收起"}</button></div></div>
        ${collapsed ? "" : (allSubRows.length ? `<div class="ol-tmdb-sub-list">${allSubRows.join("")}</div>` : '<span class="ol-tmdb-sub-hint">无可改名字幕，或点击上方按钮扫描子目录</span>')}
      </div>`;
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
      const batchCollapsed = localStorage.getItem(STORAGE.batchPreviewCollapsed) === "true";
      const subCollapsed = localStorage.getItem(STORAGE.subPreviewCollapsed) === "true";
      const failedCount = rows.filter((r) => r.error).length;
      const pendingCount = rows.filter((r) => !r.error && !r.result && !r.episodeDetails).length;
      const matchedCount = rows.filter((r) => r.episodeDetails).length;
      const batchSummary = batchCollapsed ? `<span class="ol-tmdb-meta">${rows.length} 集 · 已匹配 ${matchedCount} · 待更新 ${pendingCount} · 失败 ${failedCount}</span>` : "";
      preview.innerHTML = `
        ${renderBatchOverview(rows)}
        <div class="ol-tmdb-preview-head">
          <div>
            <strong>逐集预览</strong>
            <span class="ol-tmdb-meta">${escapeHtml(itemDisplayTitle(state.selectedItem))} · ${rows.length} 集</span>
            ${batchSummary}
          </div>
          <div class="ol-tmdb-preview-actions">
            <label class="ol-tmdb-local-season-label"><input class="ol-tmdb-local-season-mode" type="checkbox" ${state.localSeasonMode ? "checked" : ""}> 本地季集</label>
            <button class="ol-tmdb-action ol-tmdb-update-batch" type="button">更新逐集预览</button>
            <button type="button" class="ol-tmdb-action ol-tmdb-collapse-toggle" data-target="batch" title="${batchCollapsed ? "展开逐集预览" : "收起逐集预览"}">${batchCollapsed ? "展开" : "收起"}</button>
          </div>
        </div>
        ${batchCollapsed ? "" : renderPlanSummary(plan)}
        ${(() => {
          const sm = state.seasonMapping;
          if (!sm || sm.mode === "direct" || !sm.summary) return "";
          return `<div class="ol-tmdb-season-mapping-summary" data-kind="info"><span class="ol-tmdb-mapping-icon">🔗</span> ${escapeHtml(sm.summary)}</div>`;
        })()}
        <div class="ol-tmdb-batch-table"${batchCollapsed ? ' style="display:none"' : ""}>
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
            const sourceBadge = row.mappingSource && row.mappingSource !== "tmdb"
              ? `<span class="ol-tmdb-batch-source" data-source="${escapeHtml(row.mappingSource)}">${row.mappingSource === "inferred" ? "推断" : "本地"}</span>`
              : "";
            const midFinaleBadge = row.midSeasonFinale
              ? `<span class="ol-tmdb-batch-midfinale" title="季中结局">⚡</span>`
              : "";
            const mappingHint = row.mappedSeason != null && (row.mappedSeason !== positiveNumber(row.season) || row.mappedEpisode !== positiveNumber(row.episode))
              ? `<span class="ol-tmdb-batch-mapping" title="映射到 TMDB S${row.mappedSeason}E${row.mappedEpisode}">→ S${row.mappedSeason}E${row.mappedEpisode}</span>`
              : "";
            return `<div class="ol-tmdb-batch-row" data-kind="${escapeHtml(displayStatus.kind)}">
              <span class="ol-tmdb-code" title="${escapeHtml(row.name)}">${escapeHtml(row.name)}</span>
              <input class="ol-tmdb-input ol-tmdb-batch-input" data-name="${escapeHtml(row.name)}" data-field="season" type="text" inputmode="numeric" value="${escapeHtml(row.season)}">
              <span class="ol-tmdb-batch-episode-cell">
                <input class="ol-tmdb-input ol-tmdb-batch-input" data-name="${escapeHtml(row.name)}" data-field="episode" type="text" inputmode="numeric" value="${escapeHtml(row.episode)}">
                ${sourceBadge}
                ${mappingHint}
              </span>
              <span>${escapeHtml(row.episodeDetails?.name || "")}${midFinaleBadge}</span>
              <span class="ol-tmdb-batch-target">
                ${target.videoName ? escapeHtml(target.videoName) : "待填写"}
                ${rowPlan ? `<span class="ol-tmdb-plan">${rowPlan.steps.map(renderPlanStep).join("")}</span>` : ""}
              </span>
              <span class="ol-tmdb-batch-status">${escapeHtml(displayStatus.text)}</span>
            </div>`;
          }).join("")}
        </div>
        ${renderBatchSubtitlePreview(rows, plan, subCollapsed)}
      `;
      bindBatchOverviewActions(preview);
      $(".ol-tmdb-update-batch", preview)?.addEventListener("click", hydrateTvBatchEpisodes);
      $(".ol-tmdb-local-season-mode", preview)?.addEventListener("change", async (event) => {
        state.localSeasonMode = event.target.checked;
        localStorage.setItem(STORAGE.localSeasonMode, String(state.localSeasonMode));
        for (const row of state.tvBatchRows) {
          row.episodeDetails = null;
          row.error = "";
          row.result = "";
          row.mappedSeason = null;
          row.mappedEpisode = null;
          row.mappingSource = null;
          row.midSeasonFinale = false;
        }
        state.seasonMapping = null;
        if (!state.localSeasonMode && state.selectedItem) {
          await hydrateTvBatchEpisodes();
        } else {
          render();
          if (state.localSeasonMode) setStatus("本地模式，已跳过 TMDB 校验");
        }
      });
      // 字幕 checkbox 切换 + 扫描全部字幕按钮
      preview.querySelectorAll(".ol-tmdb-sub-check input").forEach((cb) => {
        cb.addEventListener("change", () => {
          const key = cb.dataset.subKey;
          if (cb.checked) state.excludedSubtitles.delete(key);
          else state.excludedSubtitles.add(key);
          renderPreview();
        });
      });
      $(".ol-tmdb-scan-subs", preview)?.addEventListener("click", async () => {
        const btn = $(".ol-tmdb-scan-subs", preview);
        if (btn) { btn.disabled = true; btn.textContent = "扫描中..."; }
        try {
          for (const row of rows) {
            const rp = plan.rows.find((item) => item.row === row);
            if (!rp || !rp.target?.videoName || rp.row.error) continue;
            const subs = await scanAllSubtitles(rp.sourceName);
            state.cachedSubtitles.set(rp.sourceName, subs);
          }
        } finally {
          renderPreview();
        }
      });
      $(".ol-tmdb-auto-scan-subs", preview)?.addEventListener("change", (event) => {
        localStorage.setItem(STORAGE.subtitleAutoScan, String(event.target.checked));
        if (event.target.checked && state.selectedItem && !state.subtitleAutoScanPending) {
          const hasAnyCache = rows.some((row) => {
            const rp = plan.rows.find((item) => item.row === row);
            return rp && state.cachedSubtitles.has(rp.sourceName);
          });
          if (!hasAnyCache) triggerBatchSubtitleScan(rows, plan);
        }
      });
      preview.querySelectorAll(".ol-tmdb-collapse-toggle").forEach((btn) => {
        btn.addEventListener("click", () => {
          const target = btn.dataset.target;
          const storageKey = target === "batch" ? STORAGE.batchPreviewCollapsed : STORAGE.subPreviewCollapsed;
          const current = localStorage.getItem(storageKey) === "true";
          localStorage.setItem(storageKey, String(!current));
          renderPreview();
        });
      });
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
      // 字幕改名对照：优先用扫描缓存（含子目录），否则同步取当前目录
      const sourceName = rowPlan.sourceName;
      const cachedSubs = state.cachedSubtitles.get(sourceName);
      const localSubs = cachedSubs
        ? cachedSubs
        : findSubtitleFilesFor(sourceName).map((sub) => ({ name: sub.name, dir: state.currentPath }));
      const hasSubs = localSubs.length > 0;
      const subRows = localSubs
        .map((sub) => {
          const subTarget = subtitleTargetName(sourceName, videoName, sub.name);
          if (subTarget === sub.name) return "";
          const key = `${sub.dir}::${sub.name}`;
          const checked = state.excludedSubtitles.has(key) ? "" : "checked";
          const sourceLabel = sub.matchType === "same-name" ? "当前（同名）"
            : sub.matchType === "by-episode" ? `${sub.dir.replace(state.currentPath, "").replace(/^\//, "") || sub.dir}（按集）`
            : sub.matchType === "by-episode-no-season" ? `${sub.dir.replace(state.currentPath, "").replace(/^\//, "") || sub.dir}（按集·无季）`
            : sub.dir === state.currentPath ? "当前" : sub.dir.replace(state.currentPath, "").replace(/^\//, "") || sub.dir;
          return `<div class="ol-tmdb-sub-row">
            <label class="ol-tmdb-sub-check"><input type="checkbox" ${checked} data-sub-key="${escapeHtml(key)}"><span class="ol-tmdb-code ol-tmdb-sub-source" title="${escapeHtml(sub.name)}">${escapeHtml(sub.name)}</span></label>
            <div class="ol-tmdb-sub-target"><span class="ol-tmdb-sub-arrow">→</span><span class="ol-tmdb-sub-src">${escapeHtml(sourceLabel)}</span><span class="ol-tmdb-code">${escapeHtml(subTarget)}</span></div>
          </div>`;
        })
        .filter(Boolean)
        .join("");
      const scanBtnText = cachedSubs ? "重新扫描子目录字幕" : "扫描子目录字幕";
      const autoScanChecked = resolveBoolOption(STORAGE.subtitleAutoScan, DEFAULTS.subtitleAutoScan) ? "checked" : "";
      const autoScanLabel = `<label class="ol-tmdb-auto-scan-label"><input class="ol-tmdb-auto-scan-subs" type="checkbox" ${autoScanChecked}> 自动扫描</label>`;
      const subtitlePreviewHtml = hasSubs
        ? `<div class="ol-tmdb-subtitle-preview">
            <div class="ol-tmdb-sub-head"><strong>字幕改名</strong>${autoScanLabel}<button class="ol-tmdb-action ol-tmdb-scan-subs" type="button">${scanBtnText}</button></div>
            <div class="ol-tmdb-sub-list">${subRows || '<span class="ol-tmdb-sub-hint">无可改名字幕</span>'}</div>
          </div>`
        : `<div class="ol-tmdb-subtitle-preview">
            <div class="ol-tmdb-sub-head"><strong>字幕改名</strong>${autoScanLabel}<button class="ol-tmdb-action ol-tmdb-scan-subs" type="button">${scanBtnText}</button></div>
            <span class="ol-tmdb-sub-hint">字幕如在子目录，点击上方按钮扫描</span>
          </div>`;
      preview.innerHTML = `
        ${renderPlanSummary(plan)}
        <div><strong>原文件</strong> <span class="ol-tmdb-code">${escapeHtml(file.name)}</span></div>
        <div><strong>新文件</strong> <span class="ol-tmdb-code">${escapeHtml(videoName)}</span></div>
        ${targetDir ? `<div><strong>目标目录</strong> <span class="ol-tmdb-code">${escapeHtml(targetDir)}</span></div>` : ""}
        ${subtitlePreviewHtml}
        <div class="ol-tmdb-plan">${rowPlan.steps.map(renderPlanStep).join("")}</div>
      `;
      // 字幕 checkbox 切换 + 扫描子目录字幕按钮
      preview.querySelectorAll(".ol-tmdb-sub-check input").forEach((cb) => {
        cb.addEventListener("change", () => {
          const key = cb.dataset.subKey;
          if (cb.checked) state.excludedSubtitles.delete(key);
          else state.excludedSubtitles.add(key);
          renderPreview();
        });
      });
      $(".ol-tmdb-scan-subs", preview)?.addEventListener("click", async () => {
        const btn = $(".ol-tmdb-scan-subs", preview);
        if (btn) { btn.disabled = true; btn.textContent = "扫描中..."; }
        try {
          const subs = await scanAllSubtitles(sourceName);
          state.cachedSubtitles.set(sourceName, subs);
        } finally {
          renderPreview();
        }
      });
      $(".ol-tmdb-auto-scan-subs", preview)?.addEventListener("change", (event) => {
        localStorage.setItem(STORAGE.subtitleAutoScan, String(event.target.checked));
        if (event.target.checked && state.selectedItem && !state.subtitleAutoScanPending && !state.cachedSubtitles.has(sourceName)) {
          triggerSingleSubtitleScan(sourceName);
        }
      });
    };

    const render = () => {
      renderFiles();
      renderResults();
      renderPreview();
      renderDuplicateReport();
      renderCleanupPreview();
      renderExecutionReport();
      renderCompatibilityWarnings();
      updatePermissionControls();
      const customTitleRow = $(".ol-tmdb-custom-title-row");
      if (customTitleRow) customTitleRow.dataset.hidden = String(!state.selectedItem);
      const customTagRow = $(".ol-tmdb-custom-tag-row");
      if (customTagRow) customTagRow.dataset.hidden = String(!state.selectedItem || state.mode !== "movie");
      const seasonInfo = $(".ol-tmdb-season-info");
      if (seasonInfo) seasonInfo.innerHTML = renderSeasonInfo();
      const folderStructureInfo = $(".ol-tmdb-folder-structure-info");
      if (folderStructureInfo) folderStructureInfo.innerHTML = renderFolderStructurePreview();
      const customTitleInput = $(".ol-tmdb-custom-title");
      if (customTitleInput && document.activeElement !== customTitleInput) {
        customTitleInput.value = state.customTitle;
      }
      const customYearInput = $(".ol-tmdb-custom-year");
      if (customYearInput && document.activeElement !== customYearInput) {
        customYearInput.value = state.customYear;
      }
      const customTagInput = $(".ol-tmdb-custom-tag");
      if (customTagInput && document.activeElement !== customTagInput) {
        customTagInput.value = state.customTag;
      }
      document.querySelectorAll(".ol-tmdb-search-mode-switch button").forEach((btn) => {
        btn.dataset.active = String(btn.dataset.mode === state.searchMode);
      });
      const queryInput = $(".ol-tmdb-query");
      if (queryInput) {
        queryInput.placeholder = state.searchMode === "id" ? "输入 TMDB ID（纯数字）" : "";
      }
      const executeButton = $(".ol-tmdb-execute");
      if (executeButton) executeButton.textContent = isTvBatchActive() ? "批量执行" : "执行";
    };

    const updateModeUi = () => {
      const modeFields = $(".ol-tmdb-mode-fields");
      if (modeFields) modeFields.dataset.mode = state.mode;
      const modal = $(".ol-tmdb-modal");
      if (modal) modal.dataset.mode = state.mode;
      const title = $("#ol-tmdb-title");
      if (title) title.innerHTML = `TMDB ${state.mode === "tv" ? "电视剧" : "电影"}匹配<span class="ol-tmdb-version">${SCRIPT_VERSION}</span>`;
      const hint = $(".ol-tmdb-mode-hint");
      if (hint) {
        const inf = state.modeInference;
        if (!state.modeTouched && inf && inf.reasons.length > 0) {
          const tag = inf.borderline ? "（边界，请确认）" : "";
          hint.textContent = `${inf.reasons.join("、")}${tag}`;
          hint.dataset.kind = inf.borderline ? "warn" : "info";
        } else {
          hint.textContent = "";
          hint.dataset.kind = "";
        }
      }
    };

    const switchMode = (newMode, preserveQuery = true) => {
      state.mode = newMode;
      state.modeTouched = true;
      const savedQuery = preserveQuery && state.queryTouched ? $(".ol-tmdb-query")?.value ?? "" : "";
      state.selectedItem = null;
      state.selectedEpisode = null;
      state.customTitle = "";
      const customTitleInput = $(".ol-tmdb-custom-title");
      if (customTitleInput) customTitleInput.value = "";
      state.customYear = "";
      const customYearInput = $(".ol-tmdb-custom-year");
      if (customYearInput) customYearInput.value = "";
      state.customTag = "";
      const customTagInput = $(".ol-tmdb-custom-tag");
      if (customTagInput) customTagInput.value = "";
      state.results = [];
      if (state.mode === "tv") {
        selectParsedFiles(true);
      } else {
        state.selectedNames = state.selectedName ? [state.selectedName] : [];
        state.tvBatchRows = [];
      }
      const modeSelect = $(".ol-tmdb-mode");
      if (modeSelect) modeSelect.value = state.mode;
      updateModeUi();
      hydrateSearchFromFile();
      if (preserveQuery && state.queryTouched) {
        const queryInput = $(".ol-tmdb-query");
        if (queryInput) queryInput.value = savedQuery;
      }
      render();
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
        $(".ol-tmdb-season").value = episode?.season ?? 1;
        $(".ol-tmdb-episode").value = episode?.episode || "";
        return;
      }
      const parsed = parseMovieName(file.name);
      $(".ol-tmdb-query").value = parsed.title;
      $(".ol-tmdb-year").value = parsed.year;
    };

    const selectParsedFiles = (silent = false) => {
      const parsedNames = state.files
        .filter((file) => parseEpisodeName(file.name))
        .map((file) => file.name);
      if (!parsedNames.length) {
        if (!silent) setStatus("当前目录没有可自动解析季集的视频", "error");
        return false;
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
      return true;
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
      state.modeTouched = false;
      state.mode = inferMode(state.files);
      const modeSelect = $(".ol-tmdb-mode");
      if (modeSelect) modeSelect.value = state.mode;
      updateModeUi();
      state.selectedName =
        (preferredName && state.files.some((file) => file.name === preferredName) && preferredName) ||
        (state.selectedName && state.files.some((file) => file.name === state.selectedName) && state.selectedName) ||
        state.files[0]?.name ||
        "";
      if (state.mode === "tv") {
        if (!selectParsedFiles(true)) {
          state.selectedNames = state.selectedName ? [state.selectedName] : [];
          syncTvBatchRows();
        }
      } else {
        state.selectedNames = state.selectedName ? [state.selectedName] : [];
        state.tvBatchRows = [];
      }
      if (state.selectedName) hydrateSearchFromFile();
      render();
      const capabilities = operationCapabilities();
      if (!capabilities.rename) {
        setStatus(`已以只读模式载入 ${state.files.length} 个视频文件；仍可搜索和预览`);
      } else {
        setStatus(`已载入 ${state.files.length} 个视频文件；可用写入能力：改名、目录结构化`);
      }
      return true;
    };

    const findOpenListRefreshControl = () => {
      const toolbar = $(".left-toolbar-in") || $(".left-toolbar");
      const selectors = [
        ".toolbar-refresh",
        '[data-tool="refresh"]',
        '[tips="refresh"]',
        'svg[tips="refresh"]',
        '[aria-label="refresh"]',
        '[aria-label="Refresh"]',
        '[aria-label="刷新"]',
      ];
      // 先在工具栏内查找，再兜底到整个文档（防止工具栏被遮挡或重渲染时找不到）
      for (const root of [toolbar, document]) {
        if (!root) continue;
        for (const selector of selectors) {
          const candidate = $(selector, root);
          if (candidate && !candidate.closest?.(".ol-tmdb-button-wrap")) return candidate;
        }
      }
      return null;
    };

    const triggerOpenListRefresh = () => {
      const control = findOpenListRefreshControl();
      if (!control) {
        if ($(".left-toolbar-in") || $(".left-toolbar")) {
          addCompatibilityWarning("refresh-control", "无法识别 OpenList 内部刷新按钮，操作后仅使用文件 API 回读。");
        }
        return false;
      }
      try {
        // 用 MouseEvent 派发代替 click()：OpenList 刷新按钮是 <svg tips="refresh">，
        // svg.click() 在部分浏览器下不是函数，且对 React 合成事件触发不可靠；
        // dispatchEvent 派发冒泡的 click 事件能稳定触发 Hope UI 的 onClick
        control.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
        return true;
      } catch {
        // 兜底：尝试原生 click()
        try {
          if (typeof control.click === "function") {
            control.click();
            return true;
          }
        } catch {}
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
        const searchFn = state.mode === "tv" ? searchTv : searchMovie;
        const [payload] = await Promise.all([
          searchFn(query, year),
          fetchGenres(state.mode),
        ]);
        let results = (payload.results || []).slice(0, 20);
        let downgradeNote = "";
        if (!results.length && year) {
          setStatus("带年份无结果，正在去掉年份重试...");
          const [retryPayload] = await Promise.all([
            searchFn(query, ""),
            fetchGenres(state.mode),
          ]);
          results = (retryPayload.results || []).slice(0, 20);
          if (results.length) {
            downgradeNote = "（已去掉年份）";
            const yearInput = $(".ol-tmdb-year");
            if (yearInput) yearInput.value = "";
          }
        }
        if (results.length > 1) {
          results.forEach((item) => { item._score = scoreSearchResult(query, year, item); });
          results.sort((a, b) => b._score - a._score);
        }
        state.results = results;
        state.selectedItem = null;
        state.selectedEpisode = null;
        render();
        setStatus(
          results.length
            ? `找到 ${results.length} 个结果${downgradeNote}`
            : "TMDB 无搜索结果",
          results.length ? "" : "error",
        );
        if (results.length === 1) {
          await selectItem(results[0].id);
        }
      } catch (error) {
        setStatus(error.message, "error");
      } finally {
        setBusy(false);
      }
    };

    const doSearchById = async () => {
      const id = $(".ol-tmdb-query").value.trim();
      if (!/^\d+$/.test(id)) {
        setStatus("请输入有效的 TMDB ID（纯数字）", "error");
        return;
      }
      const numericId = Number(id);
      const originalMode = state.mode;
      setBusy(true);
      try {
        const details = originalMode === "tv"
          ? await getTvDetails(numericId)
          : await getMovieDetails(numericId);
        state.selectedItem = details;
        state.customTitle = "";
        const customTitleInput = $(".ol-tmdb-custom-title");
        if (customTitleInput) customTitleInput.value = "";
        state.customYear = "";
        const customYearInput = $(".ol-tmdb-custom-year");
        if (customYearInput) customYearInput.value = "";
        state.customTag = "";
        const customTagInput = $(".ol-tmdb-custom-tag");
        if (customTagInput) customTagInput.value = "";
        state.selectedEpisode = null;
        const titleCopied = await copyTextToClipboard(itemDisplayTitle(state.selectedItem));
        if (state.mode === "tv" && isTvBatchActive()) {
          syncTvBatchRows();
          const toolbarSeason = positiveNumber($(".ol-tmdb-season")?.value);
          if (toolbarSeason != null) {
            state.tvBatchRows.forEach((row) => {
              row.season = toolbarSeason;
              row.episodeDetails = null;
              row.error = "";
              row.result = "";
              row.mappedSeason = null;
              row.mappedEpisode = null;
              row.mappingSource = null;
              row.midSeasonFinale = false;
            });
          }
          render();
          const result = await fetchTvBatchEpisodes();
          render();
          setStatus(
            result.failed
              ? `已选择 TMDB 条目，${result.failed} 项需要修正${tmdbConcurrencyNotice()}`
              : `已选择 TMDB 条目，已匹配 ${result.success} 集${tmdbConcurrencyNotice()}${titleCopied ? "，片名已复制到剪贴板" : ""}`,
            result.failed ? "error" : "ok",
          );
        } else {
          if (state.mode === "tv") {
            const season = positiveNumber($(".ol-tmdb-season")?.value) ?? 1;
            const episode = positiveNumber($(".ol-tmdb-episode")?.value) ?? 0;
            if (episode > 0) {
              state.selectedEpisode = await getTvEpisode(numericId, season, episode);
            }
          }
          render();
          setStatus(titleCopied ? "已选择 TMDB 条目，片名已复制到剪贴板" : "已选择 TMDB 条目", "ok");
        }
        state.results = [state.selectedItem];
        renderResults();
      } catch (error) {
        if (!error.message.startsWith("TMDB 条目或剧集不存在")) {
          setStatus(error.message, "error");
          return;
        }
        const otherMode = originalMode === "tv" ? "movie" : "tv";
        setStatus(`当前模式无此 ID，正在尝试${otherMode === "tv" ? "电视剧" : "电影"}模式...`);
        try {
          const otherDetails = otherMode === "tv"
            ? await getTvDetails(numericId)
            : await getMovieDetails(numericId);
          switchMode(otherMode, false);
          state.selectedItem = otherDetails;
          state.customTitle = "";
        const customTitleInput = $(".ol-tmdb-custom-title");
        if (customTitleInput) customTitleInput.value = "";
        state.customYear = "";
        const customYearInput = $(".ol-tmdb-custom-year");
        if (customYearInput) customYearInput.value = "";
        state.customTag = "";
        const customTagInput = $(".ol-tmdb-custom-tag");
        if (customTagInput) customTagInput.value = "";
        state.selectedEpisode = null;
          const titleCopied = await copyTextToClipboard(itemDisplayTitle(state.selectedItem));
          if (state.mode === "tv" && isTvBatchActive()) {
            syncTvBatchRows();
            const toolbarSeason = positiveNumber($(".ol-tmdb-season")?.value);
            if (toolbarSeason != null) {
              state.tvBatchRows.forEach((row) => {
                row.season = toolbarSeason;
                row.episodeDetails = null;
                row.error = "";
                row.result = "";
                row.mappedSeason = null;
                row.mappedEpisode = null;
                row.mappingSource = null;
                row.midSeasonFinale = false;
              });
            }
            render();
            const result = await fetchTvBatchEpisodes();
            render();
            setStatus(
              result.failed
                ? `已自动切换到电视剧模式，${result.failed} 项需要修正${tmdbConcurrencyNotice()}`
                : `已自动切换到电视剧模式，已匹配 ${result.success} 集${tmdbConcurrencyNotice()}${titleCopied ? "，片名已复制到剪贴板" : ""}`,
              result.failed ? "error" : "ok",
            );
          } else {
            if (state.mode === "tv") {
              const season = positiveNumber($(".ol-tmdb-season")?.value) ?? 1;
              const episode = positiveNumber($(".ol-tmdb-episode")?.value) ?? 0;
              if (episode > 0) {
                state.selectedEpisode = await getTvEpisode(numericId, season, episode);
              }
            }
            render();
            setStatus(`已自动切换到${otherMode === "tv" ? "电视剧" : "电影"}模式并选择条目${titleCopied ? "，片名已复制到剪贴板" : ""}`, "ok");
          }
          state.results = [state.selectedItem];
          renderResults();
        } catch (otherError) {
          if (otherError.message.startsWith("TMDB 条目或剧集不存在")) {
            setStatus(`TMDB ID ${id} 在电影和电视剧中均不存在`, "error");
          } else {
            setStatus(otherError.message, "error");
          }
        }
      } finally {
        setBusy(false);
      }
    };

    const runSearch = () => {
      if (state.searchMode === "id") doSearchById();
      else doSearch();
    };

    const hideTitleCandidateList = () => {
      const listEl = $(".ol-tmdb-candidate-list");
      if (listEl) {
        listEl.dataset.open = "false";
        listEl.innerHTML = "";
      }
      state.titleCandidates = { source: "", list: [], index: 0 };
    };

    const applyTitleCandidate = (source) => {
      const listEl = $(".ol-tmdb-candidate-list");
      if (!listEl) return;
      // 同源且当前已展示 → 收起
      if (state.titleCandidates.source === source && listEl.dataset.open === "true") {
        hideTitleCandidateList();
        return;
      }
      const sourceName = source === "file" ? selectedFile()?.name : currentFolderName();
      if (!sourceName) {
        setStatus(source === "file" ? "请先选择一个视频文件" : "当前目录无文件夹名", "error");
        return;
      }
      const list = extractTitleCandidates(sourceName);
      if (!list.length) {
        setStatus(`无法从${source === "file" ? "文件名" : "文件夹名"}解析出影视名`, "error");
        return;
      }
      state.titleCandidates = { source, list, index: 0 };
      listEl.innerHTML = list
        .map((c, i) => `<button type="button" class="ol-tmdb-candidate-item" data-index="${i}"${i === 0 ? ' style="font-weight:bold"' : ""}>${escapeHtml(c)}</button>`)
        .join("");
      listEl.dataset.open = "true";
      const queryInput = $(".ol-tmdb-query");
      if (queryInput) queryInput.value = list[0];
      state.queryTouched = true;
      setStatus(`已从${source === "file" ? "文件名" : "文件夹名"}解析出 ${list.length} 个候选，请点选`, "ok");
    };

    const selectItem = async (id) => {
      setBusy(true);
      setStatus(`正在读取${state.mode === "tv" ? "电视剧" : "电影"}详情...`);
      try {
        state.selectedItem = state.mode === "tv" ? await getTvDetails(id) : await getMovieDetails(id);
        state.customTitle = "";
        const customTitleInput = $(".ol-tmdb-custom-title");
        if (customTitleInput) customTitleInput.value = "";
        state.customYear = "";
        const customYearInput = $(".ol-tmdb-custom-year");
        if (customYearInput) customYearInput.value = "";
        state.customTag = "";
        const customTagInput = $(".ol-tmdb-custom-tag");
        if (customTagInput) customTagInput.value = "";
        state.selectedEpisode = null;
        // 选中条目即把影视名（不含年份）写入剪贴板
        const titleCopied = await copyTextToClipboard(itemDisplayTitle(state.selectedItem));
        if (state.mode === "tv" && isTvBatchActive()) {
          syncTvBatchRows();
          // 工具栏「季」手动填的值优先于文件名解析出的季（解析错误或缺失时由用户兜底）
          // 仅在「选中 TMDB 条目」时应用一次；之后改工具栏不再联动，需重新选中条目才生效
          const toolbarSeason = positiveNumber($(".ol-tmdb-season")?.value);
          if (toolbarSeason != null) {
            state.tvBatchRows.forEach((row) => {
              row.season = toolbarSeason;
              row.episodeDetails = null; // 失效缓存，让下方按新季重新拉取
              row.error = "";
              row.result = "";
              row.mappedSeason = null;
              row.mappedEpisode = null;
              row.mappingSource = null;
              row.midSeasonFinale = false;
            });
          }
          // 先渲染一次：季信息（原始语言/季列表）立即显示，集预览随后异步更新
          render();
          const result = isLocalSeasonMode()
            ? { success: state.tvBatchRows.length, failed: 0, concurrency: state.tmdbConcurrency }
            : await fetchTvBatchEpisodes();
          render();
          setStatus(
            isLocalSeasonMode()
              ? `已选择 TMDB 条目（本地模式）${titleCopied ? "，片名已复制到剪贴板" : ""}`
              : result.failed
                ? `已选择 TMDB 条目，${result.failed} 项需要修正${tmdbConcurrencyNotice()}`
                : `已选择 TMDB 条目，已匹配 ${result.success} 集${tmdbConcurrencyNotice()}${titleCopied ? "，片名已复制到剪贴板" : ""}`,
            result.failed ? "error" : "ok",
          );
          if (resolveBoolOption(STORAGE.subtitleAutoScan, DEFAULTS.subtitleAutoScan) && !state.subtitleAutoScanPending) {
            const batchRows = state.tvBatchRows;
            const batchPlan = buildBatchExecutionPlan();
            const hasAnyCache = batchRows.some((row) => {
              const rp = batchPlan.rows.find((item) => item.row === row);
              return rp && state.cachedSubtitles.has(rp.sourceName);
            });
            if (!hasAnyCache) triggerBatchSubtitleScan(batchRows, batchPlan);
          }
          return;
        }
        if (state.mode === "tv") {
          const season = positiveNumber($(".ol-tmdb-season")?.value) ?? 1;
          const episode = positiveNumber($(".ol-tmdb-episode")?.value) ?? 0;
          if (episode > 0) {
            state.selectedEpisode = await getTvEpisode(id, season, episode);
          }
        }
        render();
        setStatus(titleCopied ? "已选择 TMDB 条目，片名已复制到剪贴板" : "已选择 TMDB 条目", "ok");
        if (!isTvBatchActive() && resolveBoolOption(STORAGE.subtitleAutoScan, DEFAULTS.subtitleAutoScan) && !state.subtitleAutoScanPending) {
          const file = selectedFile();
          if (file && !state.cachedSubtitles.has(file.name)) {
            triggerSingleSubtitleScan(file.name);
          }
        }
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
      const invalidRows = state.tvBatchRows.filter((row) => positiveNumber(row.season) == null || positiveNumber(row.episode) == null);
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
        if (!isLocalSeasonMode()) await fetchTvBatchEpisodes();
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
            const subRenameGroups = new Map();
            for (const rowPlan of plan.rows) {
              if (!rowPlan.row._renamed || rowPlan.row._renamed === rowPlan.sourceName) continue;
              const subtitles = await getEffectiveSubtitles(rowPlan.sourceName);
              subtitles.forEach((sub) => {
                const subTarget = subtitleTargetName(rowPlan.sourceName, rowPlan.row._renamed, sub.name);
                if (subTarget !== sub.name) {
                  const group = subRenameGroups.get(sub.dir) || [];
                  group.push({ src_name: sub.name, new_name: subTarget });
                  subRenameGroups.set(sub.dir, group);
                }
              });
            }
            for (const [srcDir, renameObjects] of subRenameGroups) {
              setStatus(`正在改名 ${renameObjects.length} 个字幕文件...`);
              await batchRename(srcDir, renameObjects);
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
          for (const rowPlan of plan.rows) {
            if (rowPlan.row.error) continue;
            const season = positiveNumber(rowPlan.row.mappedSeason) ?? positiveNumber(rowPlan.row.season) ?? 1;
            const seasonDir = structuringSeasonDir(season);
            const moveName = rowPlan.row._renamed || rowPlan.sourceName;
            const videoGroup = moveGroups.get(seasonDir) || { srcDir: state.currentPath, names: [] };
            videoGroup.names.push(moveName);
            moveGroups.set(seasonDir, videoGroup);
            const subtitles = await getEffectiveSubtitles(rowPlan.sourceName);
            subtitles.forEach((sub) => {
              const subMoveName = options.rename
                ? subtitleTargetName(rowPlan.sourceName, rowPlan.row._renamed || rowPlan.sourceName, sub.name)
                : sub.name;
              const key = `${sub.dir}\u0000${seasonDir}`;
              const group = moveGroups.get(key) || { srcDir: sub.dir, names: [] };
              group.names.push(subMoveName);
              moveGroups.set(key, group);
            });
          }

          const moveSteps = plan.steps.filter((step) => step.type === "move" && step.run);
          activeSteps = moveSteps;
          for (const [key, group] of moveGroups) {
            const targetDir = key.includes("\u0000") ? key.split("\u0000")[1] : key;
            setStatus(`正在移动 ${group.names.length} 个文件...`);
            await moveFiles(group.srcDir, targetDir, group.names);
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
        if (!finalFailed) {
          closeModal();
          await sleep(1000);
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
        if (finalFailed) {
          const firstErrorRow = document.querySelector(".ol-tmdb-batch-row[data-kind='error']");
          if (firstErrorRow) firstErrorRow.scrollIntoView({ behavior: "smooth", block: "center" });
        }
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
            const subtitles = await getEffectiveSubtitles(oldName);
            const subRenameGroups = new Map();
            subtitles.forEach((sub) => {
              const subTarget = subtitleTargetName(oldName, newVideoName, sub.name);
              if (subTarget !== sub.name) {
                const group = subRenameGroups.get(sub.dir) || [];
                group.push({ src_name: sub.name, new_name: subTarget });
                subRenameGroups.set(sub.dir, group);
              }
            });
            let totalRenamed = 0;
            for (const [srcDir, renameObjects] of subRenameGroups) {
              setStatus(`正在改名 ${renameObjects.length} 个字幕文件...`);
              await batchRename(srcDir, renameObjects);
              totalRenamed += renameObjects.length;
            }
            if (totalRenamed) messages.push(`字幕改名 ${totalRenamed} 个`);
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
            const subtitles = await getEffectiveSubtitles(oldName);
            const moveGroups = new Map();
            const videoGroup = moveGroups.get(state.currentPath) || [];
            videoGroup.push(moveStep.name);
            moveGroups.set(state.currentPath, videoGroup);
            subtitles.forEach((sub) => {
              const subMoveName = options.rename
                ? subtitleTargetName(oldName, newVideoName, sub.name)
                : sub.name;
              const group = moveGroups.get(sub.dir) || [];
              group.push(subMoveName);
              moveGroups.set(sub.dir, group);
            });
            let totalMoved = 0;
            for (const [srcDir, names] of moveGroups) {
              setStatus(`正在移动 ${names.length} 个文件...`);
              await moveFiles(srcDir, targetDir, names);
              totalMoved += names.length;
            }
            activeStep = moveStep;
            updateExecutionReport(report, moveStep, "success");
            activeStep = null;
            if (totalMoved) messages.push(`文件已移动 ${totalMoved} 个`);
          }
        }

        const reportSummary = finishExecutionReport(report);
        state.selectedItem = null;
        state.selectedEpisode = null;
        state.results = [];
        closeModal();
        await sleep(1000);
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
            <h2 class="ol-tmdb-title" id="ol-tmdb-title">TMDB 匹配<span class="ol-tmdb-version">v${SCRIPT_VERSION}</span></h2>
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
                <button class="ol-tmdb-action ol-tmdb-duplicate-run" type="button">重复检测</button>
              </div>
              <div class="ol-tmdb-compatibility"></div>
              <div class="ol-tmdb-permissions"></div>
              <div class="ol-tmdb-row ol-tmdb-tv-only ol-tmdb-batch-actions">
                <button class="ol-tmdb-action ol-tmdb-select-all-files" type="button">全选</button>
                <button class="ol-tmdb-action ol-tmdb-select-parsed-files" type="button">选择可解析</button>
                <button class="ol-tmdb-action ol-tmdb-clear-files" type="button">清空</button>
              </div>
              <div class="ol-tmdb-list">
                <div class="ol-tmdb-list-head"><span></span><span>当前目录视频</span><span>大小</span></div>
                <div class="ol-tmdb-files"></div>
              </div>
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
                <label class="ol-tmdb-field" style="flex: 3">
                  <span class="ol-tmdb-label ol-tmdb-search-mode-field">
                    搜索词
                    <span class="ol-tmdb-query-tools">
                      <button type="button" class="ol-tmdb-query-clear" title="清空搜索词" aria-label="清空搜索词">×</button>
                      <button type="button" class="ol-tmdb-query-restore" title="恢复为文件名解析结果" aria-label="恢复为文件名解析结果">↺</button>
                      <button type="button" class="ol-tmdb-query-title-file" title="从视频文件名解析影视名（再次点击切换下一候选）" aria-label="从视频文件名解析影视名">名</button>
                      <button type="button" class="ol-tmdb-query-title-dir" title="从文件夹名解析影视名（再次点击切换下一候选）" aria-label="从文件夹名解析影视名">夹</button>
                    </span>
                    <span class="ol-tmdb-search-mode-switch" role="group" aria-label="搜索方式">
                      <button type="button" data-mode="keyword" data-active="true">关键词</button>
                      <button type="button" data-mode="id">ID</button>
                    </span>
                  </span>
                  <input class="ol-tmdb-input ol-tmdb-query" type="text">
                  <div class="ol-tmdb-candidate-list" data-open="false"></div>
                </label>
                <label class="ol-tmdb-field ol-tmdb-movie-only" style="flex: 0.6">
                  <span class="ol-tmdb-label ol-tmdb-search-mode-field">
                    年份
                    <span class="ol-tmdb-query-tools">
                      <button type="button" class="ol-tmdb-year-clear" title="清空年份" aria-label="清空年份">×</button>
                    </span>
                  </span>
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
                <div class="ol-tmdb-search-group">
                  <span class="ol-tmdb-site-links">
                    <button type="button" class="ol-tmdb-tmdb-link" title="跳转到 TMDB 官网首页" aria-label="跳转到 TMDB 官网首页">T</button>
                    <button type="button" class="ol-tmdb-douban-link" title="跳转到豆瓣电影首页" aria-label="跳转到豆瓣电影首页">豆</button>
                  </span>
                  <button class="ol-tmdb-action ol-tmdb-search" type="button" data-primary="true">搜索</button>
                </div>
              </div>
              <span class="ol-tmdb-mode-hint"></span>
              <div class="ol-tmdb-list">
                <div class="ol-tmdb-results"></div>
              </div>
              <div class="ol-tmdb-custom-title-row" data-hidden="true">
                <label class="ol-tmdb-field">
                  <span class="ol-tmdb-label">自定义标题（留空使用 TMDB 原标题）</span>
                  <input class="ol-tmdb-input ol-tmdb-custom-title" type="text" placeholder="如 TMDB 标题未及时更新可在此覆盖">
                </label>
                <label class="ol-tmdb-field ol-tmdb-custom-year-field">
                  <span class="ol-tmdb-label">自定义年份</span>
                  <input class="ol-tmdb-input ol-tmdb-custom-year" type="text" inputmode="numeric" placeholder="如 2024">
                </label>
              </div>
              <div class="ol-tmdb-custom-tag-row ol-tmdb-movie-only" data-hidden="true">
                <label class="ol-tmdb-field">
                  <span class="ol-tmdb-label">自定义标签（可选，追加在年份后）<span class="ol-tmdb-tag-presets"><button type="button" data-tag="TC超清版">TC超清版</button><button type="button" data-tag="国际无删减版">国际无删减版</button><button type="button" data-tag="粤语版">粤语版</button><button type="button" data-tag="国语版">国语版</button><button type="button" data-tag="4K超清版">4K超清版</button></span></span>
                  <input class="ol-tmdb-input ol-tmdb-custom-tag" type="text" placeholder="如 TC超清版、IMAX">
                </label>
              </div>
              <div class="ol-tmdb-season-info"></div>
              <div class="ol-tmdb-folder-structure-info"></div>
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
              <div class="ol-tmdb-row ol-tmdb-naming-options">
                <label class="ol-tmdb-check ol-tmdb-tv-only"><input class="ol-tmdb-include-episode-title" type="checkbox"> 包含集标题</label>
                <label class="ol-tmdb-check"><input class="ol-tmdb-include-year" type="checkbox"> 包含年份</label>
                <label class="ol-tmdb-check"><input class="ol-tmdb-embed-tmdb-id" type="checkbox"> 嵌入 TMDB ID</label>
                <label class="ol-tmdb-image-size-field ol-tmdb-tmdb-id-mode-field">
                  <span title="开启嵌入 TMDB ID 时，选择哪些文件嵌入（文件夹始终嵌入）">ID 文件</span>
                  <select class="ol-tmdb-select ol-tmdb-tmdb-id-mode" title="选择哪些文件嵌入 TMDB ID（文件夹始终嵌入）">
                    <option value="files-both">电影/电视剧文件</option>
                    <option value="files-neither">仅文件夹</option>
                    <option value="files-movie-only">仅电影文件</option>
                    <option value="files-tv-only">仅电视剧文件</option>
                  </select>
                </label>
                <label class="ol-tmdb-image-size-field">
                  <span>季目录</span>
                  <select class="ol-tmdb-select ol-tmdb-season-dir-format">
                    <option value="season-2digit">Season 01</option>
                    <option value="s-2digit">S01</option>
                    <option value="season-1digit">Season 1</option>
                  </select>
                </label>
                <label class="ol-tmdb-image-size-field">
                  <span title="字幕后缀处理策略：保留完整后缀 / 保留原有后缀 / 仅保留语言标签 / 仅保留文件后缀">字幕后缀</span>
                  <select class="ol-tmdb-select ol-tmdb-subtitle-suffix-strategy" title="字幕后缀处理策略">
                    <option value="all">保留完整后缀</option>
                    <option value="original">保留原有后缀</option>
                    <option value="lang-only">仅保留语言标签</option>
                    <option value="ext-only">仅保留文件后缀</option>
                  </select>
                </label>
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
        const preserveQuery = state.queryTouched;
        const savedQuery = preserveQuery ? $(".ol-tmdb-query")?.value ?? "" : "";
        hydrateSearchFromFile();
        if (preserveQuery) {
          const queryInput = $(".ol-tmdb-query");
          if (queryInput) queryInput.value = savedQuery;
        }
        render();
      });
      $(".ol-tmdb-select-parsed-files", mask).addEventListener("click", () => {
        if (selectParsedFiles()) render();
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
        switchMode(event.target.value);
      });
      $(".ol-tmdb-search", mask).addEventListener("click", runSearch);
      $(".ol-tmdb-search-mode-switch", mask).addEventListener("click", (event) => {
        const btn = event.target.closest("button[data-mode]");
        if (!btn) return;
        state.searchMode = btn.dataset.mode;
        document.querySelectorAll(".ol-tmdb-search-mode-switch button").forEach((b) => {
          b.dataset.active = String(b.dataset.mode === state.searchMode);
        });
        const queryInput = $(".ol-tmdb-query", mask);
        if (queryInput) {
          queryInput.placeholder = state.searchMode === "id" ? "输入 TMDB ID（纯数字）" : "";
        }
      });
      $(".ol-tmdb-query", mask).addEventListener("keydown", (event) => {
        if (event.key === "Enter") runSearch();
      });
      $(".ol-tmdb-query", mask).addEventListener("input", () => {
        state.queryTouched = true;
      });
      $(".ol-tmdb-year", mask).addEventListener("keydown", (event) => {
        if (event.key === "Enter") runSearch();
      });
      $(".ol-tmdb-query-clear", mask).addEventListener("click", () => {
        const queryInput = $(".ol-tmdb-query", mask);
        if (queryInput) {
          queryInput.value = "";
          queryInput.focus();
          state.queryTouched = true;
        }
      });
      $(".ol-tmdb-year-clear", mask).addEventListener("click", () => {
        const yearInput = $(".ol-tmdb-year", mask);
        if (yearInput) {
          yearInput.value = "";
          yearInput.focus();
        }
      });
      $(".ol-tmdb-query-restore", mask).addEventListener("click", () => {
        const file = selectedFile();
        if (!file) {
          setStatus("请先选择一个视频文件以恢复解析结果", "error");
          return;
        }
        hydrateSearchFromFile();
        state.queryTouched = false;
      });
      $(".ol-tmdb-query-title-file", mask).addEventListener("click", () => applyTitleCandidate("file"));
      $(".ol-tmdb-query-title-dir", mask).addEventListener("click", () => applyTitleCandidate("dir"));
      // [TMDB] 按钮：新窗口跳转到 TMDB 官网首页
      $(".ol-tmdb-tmdb-link", mask).addEventListener("click", () => {
        window.open("https://www.themoviedb.org/", "_blank", "noopener,noreferrer");
      });
      // [豆瓣] 按钮：新窗口跳转到豆瓣电影首页
      $(".ol-tmdb-douban-link", mask).addEventListener("click", () => {
        window.open("https://movie.douban.com/", "_blank", "noopener,noreferrer");
      });
      // 候选项点击：填入搜索框并收起列表（事件委托，列表内容动态生成）
      $(".ol-tmdb-candidate-list", mask).addEventListener("click", (event) => {
        const item = event.target.closest(".ol-tmdb-candidate-item");
        if (!item) return;
        const idx = Number(item.dataset.index);
        const value = state.titleCandidates.list[idx];
        if (value == null) return;
        const queryInput = $(".ol-tmdb-query");
        if (queryInput) queryInput.value = value;
        hideTitleCandidateList();
        setStatus(`已填入：${value}`, "ok");
      });
      $(".ol-tmdb-custom-title", mask).addEventListener("input", (event) => {
        state.customTitle = event.target.value;
        renderPreview();
      });
      $(".ol-tmdb-custom-year", mask).addEventListener("input", (event) => {
        state.customYear = event.target.value;
        renderPreview();
      });
      $(".ol-tmdb-custom-tag", mask).addEventListener("input", (event) => {
        state.customTag = event.target.value;
        renderPreview();
      });
      mask.querySelectorAll(".ol-tmdb-tag-presets button").forEach((btn) => {
        btn.addEventListener("click", () => {
          const tag = btn.dataset.tag;
          state.customTag = tag;
          const customTagInput = $(".ol-tmdb-custom-tag");
          if (customTagInput) customTagInput.value = tag;
          renderPreview();
        });
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
      const namingOptionStorage = new Map([
        ["ol-tmdb-include-episode-title", STORAGE.includeEpisodeTitle],
        ["ol-tmdb-include-year", STORAGE.includeYear],
        ["ol-tmdb-embed-tmdb-id", STORAGE.embedTmdbId],
      ]);
      mask.querySelectorAll(".ol-tmdb-include-episode-title, .ol-tmdb-include-year, .ol-tmdb-embed-tmdb-id").forEach((input) => {
        input.addEventListener("change", () => {
          const storageKey = [...input.classList]
            .map((className) => namingOptionStorage.get(className))
            .find(Boolean);
          if (storageKey) localStorage.setItem(storageKey, input.checked ? "true" : "false");
          if (input.classList.contains("ol-tmdb-embed-tmdb-id")) {
            const tmdbIdModeSelect = $(".ol-tmdb-tmdb-id-mode", mask);
            if (tmdbIdModeSelect) tmdbIdModeSelect.disabled = !input.checked;
          }
          renderPreview();
        });
      });
      $(".ol-tmdb-season-dir-format", mask).addEventListener("change", (event) => {
        const value = event.target.value;
        if (SEASON_DIR_FORMATS.includes(value)) {
          localStorage.setItem(STORAGE.seasonDirFormat, value);
          renderPreview();
        }
      });
      $(".ol-tmdb-tmdb-id-mode", mask).addEventListener("change", (event) => {
        const value = event.target.value;
        if (TMDB_ID_FILE_MODES.includes(value)) {
          localStorage.setItem(STORAGE.tmdbIdFileMode, value);
          renderPreview();
        }
      });
      $(".ol-tmdb-subtitle-suffix-strategy", mask).addEventListener("change", (event) => {
        const value = event.target.value;
        if (SUBTITLE_SUFFIX_STRATEGIES.includes(value)) {
          localStorage.setItem(STORAGE.subtitleSuffixStrategy, value);
          renderPreview();
        }
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
        state._tmdbSuccessStreak = 0;
        localStorage.setItem(STORAGE.concurrency, String(concurrency));
        setStatus(`批量 TMDB 请求并发已设为 ${concurrency}`);
      });
      $(".ol-tmdb-execute", mask).addEventListener("click", execute);
      mask.addEventListener("click", (event) => {
        if (event.target === mask) closeModal();
      });
      const defaults = datasetDefaults();
      $(".ol-tmdb-api-key", mask).value = localStorage.getItem(STORAGE.key) || DEFAULT_TMDB_API_KEY || "";
      $(".ol-tmdb-language", mask).value = localStorage.getItem(STORAGE.language) || "zh-CN";
      $(".ol-tmdb-mode", mask).value = state.mode;
      $(".ol-tmdb-do-rename", mask).checked = resolveBoolOption(STORAGE.rename, defaults.rename);
      $(".ol-tmdb-do-structuring", mask).checked = resolveBoolOption(STORAGE.structuring, defaults.structuring);
      $(".ol-tmdb-concurrency", mask).value = String(state.tmdbConcurrencyLimit);
      $(".ol-tmdb-include-episode-title", mask).checked = resolveBoolOption(STORAGE.includeEpisodeTitle, defaults.includeEpisodeTitle);
      $(".ol-tmdb-include-year", mask).checked = resolveBoolOption(STORAGE.includeYear, defaults.includeYear);
      $(".ol-tmdb-embed-tmdb-id", mask).checked = resolveBoolOption(STORAGE.embedTmdbId, defaults.embedTmdbId);
      const tmdbIdModeSelect = $(".ol-tmdb-tmdb-id-mode", mask);
      if (tmdbIdModeSelect) {
        tmdbIdModeSelect.value = resolveEnumOption(STORAGE.tmdbIdFileMode, TMDB_ID_FILE_MODES, defaults.tmdbIdFileMode);
        tmdbIdModeSelect.disabled = !resolveBoolOption(STORAGE.embedTmdbId, defaults.embedTmdbId);
      }
      $(".ol-tmdb-season-dir-format", mask).value = resolveEnumOption(STORAGE.seasonDirFormat, SEASON_DIR_FORMATS, defaults.seasonDirFormat);
      $(".ol-tmdb-subtitle-suffix-strategy", mask).value = resolveEnumOption(STORAGE.subtitleSuffixStrategy, SUBTITLE_SUFFIX_STRATEGIES, defaults.subtitleSuffixStrategy);
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
      const pathChanged = path !== state.currentPath;
      if (pathChanged) resetDirectoryState(path);
      createModal();
      $("#ol-tmdb-mask").dataset.open = "true";
      if (pathChanged || !state.modeTouched) {
        state.modeTouched = false;
        state.mode = inferMode(state.files);
      }
      const modeSelect = $(".ol-tmdb-mode");
      if (modeSelect) modeSelect.value = state.mode;
      updateModeUi();
      state.results = [];
      state.selectedItem = null;
      state.selectedEpisode = null;
      state.queryTouched = false;
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
