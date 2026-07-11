const firebaseConfig = {
  apiKey: "AIzaSyCo_70hpwOSLo2zwjWboblvJkw87EKaNbw",
  authDomain: "lbox-25154.firebaseapp.com",
  projectId: "lbox-25154",
  storageBucket: "lbox-25154.firebasestorage.app",
  messagingSenderId: "256135776739",
  appId: "1:256135776739:web:659c580df1b6ff273ab8d6",
  measurementId: "G-MC5Z0CELQL",
};

const BOX_INTERVALS = [0, 1, 3, 7, 14, 30];
const STORAGE_KEY = "lighner-box-state-v1";
const APP_STORAGE_KEY = "lighner-box-app-v2";
const PROFILE_STORAGE_KEY = "lighner-box-profile-v2";
const ADMIN_SESSION_KEY = "lighner-box-admin-session-v1";
const PROFILE_MODE_KEY = "lighner-box-profile-mode-v1";
const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "lbox-admin";
const todayKey = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

const defaultAppData = {
  languages: ["English", "Swedish", "Persian"],
  categories: [{ id: "general", name: "General" }],
  vocab: [],
};

const defaultProfileData = {
  profile: { name: "My profile", code: "", cloudUserId: "" },
  progress: {},
  reviews: [],
};

let appData = loadLocalAppData();
let profileData = loadLocalProfileData();
let currentCard = null;
let cloud = null;
let statusMessage = "";
let logs = [];
let adminUnlocked = sessionStorage.getItem(ADMIN_SESSION_KEY) === "true";
let profileMode = sessionStorage.getItem(PROFILE_MODE_KEY) || "create";

const $ = (id) => document.getElementById(id);

init();

async function init() {
  bindNavigation();
  bindStudy();
  bindAdmin();
  bindProfile();
  try {
    await initCloud();
  } catch (error) {
    cloud = null;
    setStatus(`Firebase failed: ${readableFirebaseError(error)}`);
  }
  render();
}

function loadLocalAppData() {
  const legacy = loadLegacyState();
  const raw = localStorage.getItem(APP_STORAGE_KEY);
  if (!raw) return legacy ? pickAppData(legacy) : structuredClone(defaultAppData);
  try {
    return { ...structuredClone(defaultAppData), ...JSON.parse(raw) };
  } catch {
    return legacy ? pickAppData(legacy) : structuredClone(defaultAppData);
  }
}

function loadLocalProfileData() {
  const legacy = loadLegacyState();
  const raw = localStorage.getItem(PROFILE_STORAGE_KEY);
  if (!raw) return legacy ? pickProfileData(legacy) : structuredClone(defaultProfileData);
  try {
    return { ...structuredClone(defaultProfileData), ...JSON.parse(raw) };
  } catch {
    return legacy ? pickProfileData(legacy) : structuredClone(defaultProfileData);
  }
}

function loadLegacyState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pickAppData(data) {
  const categories = normalizeCategories(data.categories);
  return {
    languages: Array.isArray(data.languages) && data.languages.length === 3 ? data.languages : defaultAppData.languages,
    categories,
    vocab: normalizeVocab(data.vocab, categories),
  };
}

function pickProfileData(data) {
  return {
    profile: { ...defaultProfileData.profile, ...(data.profile || {}) },
    progress: data.progress || {},
    reviews: Array.isArray(data.reviews) ? data.reviews : [],
  };
}

async function saveAppData() {
  if (!adminUnlocked) {
    const error = new Error("Admin login is required to change shared vocabulary");
    setStatus(error.message);
    logDebug("admin:blocked-write");
    throw error;
  }
  localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(appData));
  logDebug("app:local-save", { words: appData.vocab.length });
  if (cloud) {
    try {
      await cloud.saveAppData(appData);
      setStatus("Saved shared vocabulary to cloud");
      logDebug("app:cloud-save-ok", { words: appData.vocab.length });
    } catch (error) {
      setStatus(`Cloud vocabulary save failed: ${readableFirebaseError(error)}`);
      logDebug("app:cloud-save-failed", error);
      throw error;
    }
  }
  render();
}

async function saveProfileData() {
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profileData));
  logDebug("profile:local-save", { code: profileData.profile.code || "(none)" });
  if (cloud && profileData.profile.code) {
    try {
      await cloud.saveProfile(profileData);
      setStatus(`Saved to cloud profile: ${profileData.profile.code}`);
      logDebug("profile:cloud-save-ok", { code: profileData.profile.code });
    } catch (error) {
      setStatus(`Cloud save failed: ${readableFirebaseError(error)}`);
      logDebug("profile:cloud-save-failed", error);
      throw error;
    }
  }
  render();
}

async function initCloud() {
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    $("syncStatus").textContent = "Local profile";
    logDebug("firebase:missing-config");
    return;
  }

  setStatus("Connecting to Firebase...");
  logDebug("firebase:init-start", {
    host: location.host,
    origin: location.origin,
    projectId: firebaseConfig.projectId,
  });

  const [{ initializeApp }, { getAuth, signInAnonymously, onAuthStateChanged }, firestore] = await withTimeout(Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js"),
  ]), 10000, "Firebase SDK import timed out");

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = firestore.getFirestore(app);
  await withTimeout(signInAnonymously(auth), 10000, "Anonymous sign-in timed out");
  await withTimeout(new Promise((resolve) => onAuthStateChanged(auth, resolve)), 10000, "Auth state timed out");
  profileData.profile.cloudUserId = auth.currentUser.uid;
  logDebug("firebase:auth-ok", { uid: auth.currentUser.uid });

  cloud = {
    async loadAppData() {
      const ref = firestore.doc(db, "app", "main");
      logDebug("app:cloud-load-start", { path: "app/main" });
      const snap = await firestore.getDoc(ref);
      const data = snap.exists() ? snap.data() : null;
      logDebug("app:cloud-load-result", {
        exists: snap.exists(),
        words: data?.vocab?.length || 0,
        categories: data?.categories?.length || 0,
      });
      return data ? pickAppData(data) : null;
    },
    async saveAppData(nextAppData) {
      const ref = firestore.doc(db, "app", "main");
      logDebug("app:cloud-save-start", {
        path: "app/main",
        words: nextAppData.vocab.length,
        categories: nextAppData.categories.length,
      });
      await firestore.setDoc(ref, {
        ...nextAppData,
        updatedAt: firestore.serverTimestamp(),
      });
    },
    async loadProfile(code) {
      const ref = firestore.doc(db, "profiles", code);
      logDebug("profile:cloud-load-start", { path: `profiles/${code}` });
      const snap = await firestore.getDoc(ref);
      const data = snap.exists() ? snap.data() : null;
      logDebug("profile:cloud-load-result", { exists: snap.exists(), code });
      return data ? pickProfileData(data) : null;
    },
    async saveProfile(nextProfileData) {
      const ref = firestore.doc(db, "profiles", nextProfileData.profile.code);
      logDebug("profile:cloud-save-start", { path: `profiles/${nextProfileData.profile.code}` });
      await firestore.setDoc(ref, {
        ...nextProfileData,
        updatedAt: firestore.serverTimestamp(),
      });
    },
  };
  const remoteAppData = await cloud.loadAppData();
  if (remoteAppData) {
    appData = mergeAppData(appData, remoteAppData);
    localStorage.setItem(APP_STORAGE_KEY, JSON.stringify(appData));
  }
  setStatus("Cloud sync ready");
}

function bindNavigation() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab, .view").forEach((el) => el.classList.remove("active"));
      tab.classList.add("active");
      $(tab.dataset.view).classList.add("active");
      render();
    });
  });
}

function bindStudy() {
  $("studyLanguage").addEventListener("change", renderStudy);
  $("studyCategory").addEventListener("change", renderStudy);
  $("revealAnswer").addEventListener("click", () => $("answerPanel").classList.remove("hidden"));
  $("againBtn").addEventListener("click", () => review("again"));
  $("hardBtn").addEventListener("click", () => review("hard"));
  $("goodBtn").addEventListener("click", () => review("good"));
  $("easyBtn").addEventListener("click", () => review("easy"));
  $("resetProgress").addEventListener("click", async () => {
    profileData.progress = {};
    profileData.reviews = [];
    await saveProfileData();
  });
}

function bindAdmin() {
  $("csvFile").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    await importCsv(await file.text());
    event.target.value = "";
  });
  $("importPasted").addEventListener("click", async () => {
    await importCsv($("csvPaste").value);
    $("csvPaste").value = "";
  });
  $("languageNames").addEventListener("change", async () => {
    const names = $("languageNames").value.split(",").map((part) => part.trim()).filter(Boolean).slice(0, 3);
    if (names.length === 3) {
      appData.languages = names;
      await saveAppData();
    }
  });
  $("downloadCsv").addEventListener("click", downloadCsv);
  $("clearVocab").addEventListener("click", async () => {
    appData.vocab = [];
    await saveAppData();
  });
  $("clearLogs").addEventListener("click", () => {
    logs = [];
    renderLogs();
  });
  $("adminLoginBtn").addEventListener("click", unlockAdmin);
  $("adminPassword").addEventListener("keydown", (event) => {
    if (event.key === "Enter") unlockAdmin();
  });
  $("adminLogout").addEventListener("click", () => {
    adminUnlocked = false;
    sessionStorage.removeItem(ADMIN_SESSION_KEY);
    $("adminStatus").textContent = "Admin locked.";
    logDebug("admin:logout");
    renderAdminGate();
  });
}

function unlockAdmin() {
  const username = $("adminUsername").value.trim();
  const password = $("adminPassword").value.trim();
  logDebug("admin:login-click", { username, hasPassword: Boolean(password) });
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    adminUnlocked = true;
    sessionStorage.setItem(ADMIN_SESSION_KEY, "true");
    $("adminPassword").value = "";
    $("adminStatus").textContent = "Admin unlocked.";
    logDebug("admin:login-ok", { username });
    renderAdminGate();
    return;
  }
  $("adminStatus").textContent = "Invalid admin credentials.";
  logDebug("admin:login-failed", { username });
}

function bindProfile() {
  $("createProfileMode").addEventListener("click", () => setProfileMode("create"));
  $("resumeProfileMode").addEventListener("click", () => setProfileMode("resume"));
  $("profileCode").addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveProfile();
  });
  $("saveProfile").addEventListener("click", async () => {
    await saveProfile();
  });
  $("switchProfile").addEventListener("click", () => {
    setProfileMode("resume");
    $("profileCode").focus();
    renderProfileGate(true);
  });
  $("copyProfile").addEventListener("click", async () => {
    if (!profileData.profile.code) return;
    await navigator.clipboard.writeText(profileData.profile.code);
    setStatus(`Copied profile code: ${profileData.profile.code}`);
  });
}

async function saveProfile() {
  try {
    profileData.profile.name = $("profileName").value.trim() || "My profile";
    profileData.profile.code = $("profileCode").value.trim() || uid().slice(0, 8);
    if (cloud) {
      const remote = await cloud.loadProfile(profileData.profile.code);
      if (remote) profileData = mergeProfileData(profileData, remote);
    }
    await saveProfileData();
  } catch (error) {
    setStatus(`Profile save failed: ${readableFirebaseError(error)}`);
    logDebug("profile:save-failed", error);
  }
}

async function importCsv(text) {
  const rows = parseCsv(text).filter((row) => row.some(Boolean));
  if (!rows.length) return;

  const first = rows[0].map((cell) => cell.toLowerCase());
  const hasCategoryColumn = first[0] === "category";
  const hasHeader = hasCategoryColumn || first.includes("lang1") || first.includes("language 1") || appData.languages.some((lang) => first.includes(lang.toLowerCase()));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const existing = new Map(appData.vocab.map((word) => [word.key, word]));
  let added = 0;
  let updated = 0;
  const touchedCategories = new Set();

  for (const row of dataRows) {
    const rowCategory = hasCategoryColumn ? row[0] : $("categoryName").value;
    const category = upsertCategory(rowCategory);
    touchedCategories.add(category.name);
    const offset = hasCategoryColumn ? 1 : 0;
    const terms = row.slice(offset, offset + 3).map((cell) => cell.trim());
    if (terms.filter(Boolean).length < 2) continue;
    while (terms.length < 3) terms.push("");
    const key = normalizeKey(terms, category.id);
    const next = {
      id: existing.get(key)?.id || uid(),
      key,
      terms,
      categoryId: category.id,
      categoryName: category.name,
    };
    if (existing.has(key)) updated += 1;
    else added += 1;
    existing.set(key, next);
  }

  appData.vocab = [...existing.values()].sort((a, b) => a.terms[0].localeCompare(b.terms[0]));
  $("importResult").textContent = `Imported ${added} new and ${updated} updated words into ${[...touchedCategories].join(", ")}.`;
  await saveAppData();
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      cell += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

function normalizeKey(terms, categoryId = "general") {
  return `${categoryId}|${terms.map((term) => term.trim().toLowerCase()).join("|")}`;
}

function render() {
  $("profileName").value = profileData.profile.name;
  $("profileCode").value = profileData.profile.code;
  $("languageNames").value = appData.languages.join(", ");
  if (!$("categoryName").value) $("categoryName").value = appData.categories[0]?.name || "General";
  if (!statusMessage) {
    $("syncStatus").textContent = profileData.profile.code
      ? `${cloud ? "Cloud" : "Local"} profile: ${profileData.profile.code}`
      : cloud ? "Cloud sync ready" : "Local profile";
  }
  renderStudyLanguage();
  renderStudyCategory();
  renderStudy();
  renderTracker();
  renderVocabTable();
  renderAdminGate();
  renderProfileGate();
  renderLogs();
}

function setStatus(message) {
  statusMessage = message;
  $("syncStatus").textContent = message;
  const profileStatus = $("profileStatus");
  if (profileStatus) profileStatus.textContent = message;
  logDebug("status", message);
}

function logDebug(event, details = "") {
  const entry = {
    at: new Date().toISOString(),
    event,
    details: normalizeLogDetails(details),
  };
  logs = [entry, ...logs].slice(0, 80);
  renderLogs();
}

function normalizeLogDetails(details) {
  if (details instanceof Error) return readableFirebaseError(details);
  if (details && typeof details === "object") return details;
  return String(details || "");
}

function renderLogs() {
  const target = $("debugLog");
  if (!target) return;
  target.textContent = logs.map((entry) => {
    const details = typeof entry.details === "string" ? entry.details : JSON.stringify(entry.details);
    return `[${entry.at}] ${entry.event}${details ? ` ${details}` : ""}`;
  }).join("\n");
}

function renderAdminGate() {
  $("adminLogin").classList.toggle("hidden", adminUnlocked);
  $("adminTools").classList.toggle("hidden", !adminUnlocked);
  $("adminTab").textContent = adminUnlocked ? "Admin" : "Admin lock";
}

function setProfileMode(mode) {
  profileMode = mode;
  sessionStorage.setItem(PROFILE_MODE_KEY, mode);
  if (mode === "create") {
    $("profileCode").placeholder = "Leave empty for a new code";
  } else {
    $("profileCode").placeholder = "Paste profile code";
  }
  renderProfileGate(true);
}

function renderProfileGate(forceOpen = false) {
  const hasProfile = Boolean(profileData.profile.code);
  $("profileWelcome").classList.toggle("hidden", hasProfile && !forceOpen);
  $("activeProfileBar").classList.toggle("hidden", !hasProfile || forceOpen);
  $("createProfileMode").classList.toggle("active", profileMode === "create");
  $("resumeProfileMode").classList.toggle("active", profileMode === "resume");
  $("profileNameField").classList.toggle("hidden", profileMode === "resume");
  $("profileCode").placeholder = profileMode === "create" ? "Leave empty for a new code" : "Paste profile code";
  $("saveProfile").textContent = profileMode === "create" ? "Create and start" : "Resume learning";
  $("activeProfileName").textContent = profileData.profile.name || "My profile";
  $("activeProfileCode").textContent = profileData.profile.code ? `Code: ${profileData.profile.code}` : "";
}

function withTimeout(promise, milliseconds, message) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), milliseconds);
    }),
  ]);
}

function readableFirebaseError(error) {
  if (!error) return "Unknown error";
  return [error.code, error.message].filter(Boolean).join(" - ") || String(error);
}

function renderStudyLanguage() {
  const select = $("studyLanguage");
  const selected = select.value || "0";
  select.innerHTML = appData.languages.map((lang, index) => `<option value="${index}">${escapeHtml(lang)}</option>`).join("");
  select.value = selected;
}

function renderStudyCategory() {
  const select = $("studyCategory");
  const selected = select.value || "all";
  select.innerHTML = [
    '<option value="all">All categories</option>',
    ...appData.categories.map((category) => `<option value="${escapeHtml(category.id)}">${escapeHtml(category.name)}</option>`),
  ].join("");
  select.value = appData.categories.some((category) => category.id === selected) ? selected : "all";
}

function renderStudy() {
  const due = dueCards();
  currentCard = due[0] || null;
  $("dueCount").textContent = due.length;
  $("newCount").textContent = appData.vocab.filter((word) => !profileData.progress[word.id]).length;
  $("knownCount").textContent = Object.values(profileData.progress).filter((item) => item.box >= 5).length;

  $("emptyStudy").classList.toggle("hidden", Boolean(currentCard));
  $("flashcard").classList.toggle("hidden", !currentCard);
  $("answerPanel").classList.add("hidden");
  if (!currentCard) return;

  const promptIndex = Number($("studyLanguage").value || 0);
  $("cardPrompt").textContent = currentCard.terms[promptIndex] || currentCard.terms.find(Boolean);
  const progress = profileData.progress[currentCard.id] || { box: 1 };
  $("cardBox").textContent = `Box ${progress.box}`;
  $("answerList").innerHTML = currentCard.terms.map((term, index) => `
    <dt>${escapeHtml(appData.languages[index] || `Lang ${index + 1}`)}</dt>
    <dd>${escapeHtml(term || "-")}</dd>
  `).join("");
}

function dueCards() {
  const now = Date.now();
  const categoryId = $("studyCategory").value || "all";
  return appData.vocab.filter((word) => {
    if (categoryId !== "all" && word.categoryId !== categoryId) return false;
    const progress = profileData.progress[word.id];
    return !progress || progress.dueAt <= now;
  });
}

async function review(score) {
  if (!currentCard) return;
  const previous = profileData.progress[currentCard.id] || { box: 1, correct: 0, total: 0 };
  const delta = { again: -1, hard: 0, good: 1, easy: 2 }[score];
  const box = score === "again" ? 1 : Math.max(1, Math.min(5, previous.box + delta));
  const dueAt = Date.now() + BOX_INTERVALS[box] * 86400000;
  const correct = score === "again" ? previous.correct : previous.correct + 1;
  profileData.progress[currentCard.id] = { box, dueAt, correct, total: previous.total + 1, lastScore: score };
  profileData.reviews.push({ wordId: currentCard.id, score, date: todayKey(), at: Date.now() });
  await saveProfileData();
}

function renderTracker() {
  const reviews = profileData.reviews;
  const correct = reviews.filter((review) => review.score !== "again").length;
  $("totalWords").textContent = appData.vocab.length;
  $("reviewedToday").textContent = reviews.filter((review) => review.date === todayKey()).length;
  $("accuracyRate").textContent = reviews.length ? `${Math.round((correct / reviews.length) * 100)}%` : "0%";
  $("streakDays").textContent = calculateStreak(reviews);

  const counts = [1, 2, 3, 4, 5].map((box) => Object.values(profileData.progress).filter((item) => item.box === box).length);
  const max = Math.max(1, ...counts);
  $("boxBars").innerHTML = counts.map((count, index) => `
    <div class="box-row">
      <span>Box ${index + 1}</span>
      <div class="bar"><i style="width:${(count / max) * 100}%"></i></div>
      <strong>${count}</strong>
    </div>
  `).join("");
}

function calculateStreak(reviews) {
  const days = new Set(reviews.map((review) => review.date));
  let streak = 0;
  const date = new Date();
  while (days.has(date.toISOString().slice(0, 10))) {
    streak += 1;
    date.setDate(date.getDate() - 1);
  }
  return streak;
}

function renderVocabTable() {
  $("vocabHead").innerHTML = `<tr><th>Category</th>${appData.languages.map((lang) => `<th>${escapeHtml(lang)}</th>`).join("")}<th>Box</th></tr>`;
  $("vocabTable").innerHTML = appData.vocab.map((word) => {
    const box = profileData.progress[word.id]?.box || 1;
    return `<tr><td>${escapeHtml(word.categoryName || "General")}</td>${word.terms.map((term) => `<td>${escapeHtml(term)}</td>`).join("")}<td>${box}</td></tr>`;
  }).join("");
}

function downloadCsv() {
  const rows = [["Category", ...appData.languages], ...appData.vocab.map((word) => [word.categoryName || "General", ...word.terms])];
  const csv = rows.map((row) => row.map(csvCell).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "lighner-box-vocabulary.csv";
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function mergeAppData(local, remote) {
  const categories = mergeCategories(remote.categories, local.categories);
  const vocab = new Map(normalizeVocab(remote.vocab, categories).map((word) => [word.key, word]));
  normalizeVocab(local.vocab, categories).forEach((word) => vocab.set(word.key, word));
  return {
    languages: local.languages.length === 3 ? local.languages : remote.languages,
    categories,
    vocab: [...vocab.values()],
  };
}

function mergeProfileData(local, remote) {
  return {
    profile: local.profile,
    progress: { ...(remote.progress || {}), ...(local.progress || {}) },
    reviews: [...(remote.reviews || []), ...(local.reviews || [])],
  };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[char]);
}

function upsertCategory(name) {
  const cleanName = (name || "General").trim() || "General";
  const existing = appData.categories.find((category) => category.name.toLowerCase() === cleanName.toLowerCase());
  if (existing) return existing;
  const category = { id: slugify(cleanName), name: cleanName };
  const usedIds = new Set(appData.categories.map((item) => item.id));
  let uniqueId = category.id;
  let index = 2;
  while (usedIds.has(uniqueId)) {
    uniqueId = `${category.id}-${index}`;
    index += 1;
  }
  category.id = uniqueId;
  appData.categories.push(category);
  return category;
}

function normalizeCategories(categories) {
  const source = Array.isArray(categories) && categories.length ? categories : defaultAppData.categories;
  const seen = new Set();
  return source.map((category) => {
    const name = String(category.name || "General").trim() || "General";
    let id = String(category.id || slugify(name)).trim() || "general";
    while (seen.has(id)) id = `${id}-copy`;
    seen.add(id);
    return { id, name };
  });
}

function mergeCategories(remote = [], local = []) {
  const byName = new Map();
  [...normalizeCategories(remote), ...normalizeCategories(local)].forEach((category) => {
    byName.set(category.name.toLowerCase(), category);
  });
  return [...byName.values()];
}

function normalizeVocab(vocab, categories) {
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const fallback = categories[0] || defaultAppData.categories[0];
  return Array.isArray(vocab) ? vocab.map((word) => {
    const category = categoryMap.get(word.categoryId) || fallback;
    const terms = Array.isArray(word.terms) ? word.terms.slice(0, 3) : [];
    while (terms.length < 3) terms.push("");
    return {
      id: word.id || uid(),
      key: normalizeKey(terms, category.id),
      terms,
      categoryId: category.id,
      categoryName: category.name,
    };
  }) : [];
}

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "general";
}
