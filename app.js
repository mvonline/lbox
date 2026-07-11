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
const DAILY_GOAL = 10;
const XP_BY_SCORE = { again: 1, hard: 3, good: 6, easy: 8 };
const MANUAL_BATCH_SIZE = 30;
const todayKey = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

const defaultAppData = {
  languages: ["English", "Swedish", "Persian"],
  categories: [{ id: "general", name: "General" }],
  labels: [],
  vocab: [],
};

const defaultProfileData = {
  profile: { name: "", id: "", code: "", cloudUserId: "", targetLanguageIndex: 0 },
  progress: {},
  reviews: [],
  stats: { points: 0, lastReviewDate: "", streak: 0, bestStreak: 0 },
};

let appData = loadLocalAppData();
let profileData = loadLocalProfileData();
let currentCard = null;
let cloud = null;
let statusMessage = "";
let logs = [];
let adminUnlocked = sessionStorage.getItem(ADMIN_SESSION_KEY) === "true";
let profileMode = sessionStorage.getItem(PROFILE_MODE_KEY) || "create";
let manualReviewFilter = "all";
let manualVisibleCount = MANUAL_BATCH_SIZE;

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
  const labels = mergeLabels(data.labels, collectLabelsFromVocab(data.vocab));
  return {
    languages: Array.isArray(data.languages) && data.languages.length === 3 ? data.languages : defaultAppData.languages,
    categories,
    labels,
    vocab: normalizeVocab(data.vocab, categories, labels),
  };
}

function pickProfileData(data) {
  const profile = { ...defaultProfileData.profile, ...(data.profile || {}) };
  const isOldEmptyDefault = profile.name === "My profile" && !profile.id && !profile.code;
  profile.id = isOldEmptyDefault ? "" : profile.id || profile.code || profileIdFromName(profile.name);
  profile.code = profile.code || profile.id;
  return {
    profile,
    progress: data.progress || {},
    reviews: Array.isArray(data.reviews) ? data.reviews : [],
    stats: { ...defaultProfileData.stats, ...(data.stats || {}) },
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
  logDebug("profile:local-save", { name: profileData.profile.name || "(none)" });
  if (cloud && profileData.profile.id) {
    try {
      await cloud.saveProfile(profileData);
      setStatus(`Saved profile: ${profileData.profile.name}`);
      logDebug("profile:cloud-save-ok", { name: profileData.profile.name });
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
    async loadProfile(profileId) {
      const ref = firestore.doc(db, "profiles", profileId);
      logDebug("profile:cloud-load-start", { path: `profiles/${profileId}` });
      const snap = await firestore.getDoc(ref);
      const data = snap.exists() ? snap.data() : null;
      logDebug("profile:cloud-load-result", { exists: snap.exists(), profileId });
      return data ? pickProfileData(data) : null;
    },
    async saveProfile(nextProfileData) {
      const ref = firestore.doc(db, "profiles", nextProfileData.profile.id);
      logDebug("profile:cloud-save-start", { path: `profiles/${nextProfileData.profile.id}` });
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
  $("menuToggle").addEventListener("click", () => {
    const nav = $("mainNav");
    const isOpen = nav.classList.toggle("open");
    $("menuToggle").setAttribute("aria-expanded", String(isOpen));
  });
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showView(tab.dataset.view));
  });
}

function showView(viewId) {
  const view = $(viewId);
  if (!view) return;
  document.querySelectorAll(".tab, .view").forEach((el) => el.classList.remove("active"));
  const tab = document.querySelector(`.tab[data-view="${viewId}"]`);
  if (tab) tab.classList.add("active");
  view.classList.add("active");
  $("mainNav").classList.remove("open");
  $("menuToggle").setAttribute("aria-expanded", "false");
  render();
}

function bindStudy() {
  $("studyLanguage").addEventListener("change", async () => {
    profileData.profile.targetLanguageIndex = Number($("studyLanguage").value || 0);
    $("profileTargetLanguage").value = String(profileData.profile.targetLanguageIndex);
    renderStudy();
    if (profileData.profile.id) await saveProfileData();
  });
  $("studyCategory").addEventListener("change", renderStudy);
  $("studyLabel").addEventListener("change", renderStudy);
  $("studyMode").addEventListener("change", renderStudy);
  $("studyOrder").addEventListener("change", renderStudy);
  $("revealAnswer").addEventListener("click", () => $("answerPanel").classList.remove("hidden"));
  $("againBtn").addEventListener("click", () => review("again"));
  $("hardBtn").addEventListener("click", () => review("hard"));
  $("goodBtn").addEventListener("click", () => review("good"));
  $("easyBtn").addEventListener("click", () => review("easy"));
  document.querySelectorAll(".manual-filter").forEach((button) => {
    button.addEventListener("click", () => {
      manualReviewFilter = button.dataset.filter;
      manualVisibleCount = MANUAL_BATCH_SIZE;
      renderManualReviewList();
    });
  });
  $("manualReviewList").addEventListener("click", (event) => {
    const button = event.target.closest("[data-review-word]");
    if (!button) {
      if (event.target.closest("[data-load-more-manual]")) {
        manualVisibleCount += MANUAL_BATCH_SIZE;
        renderManualReviewList();
      }
      return;
    }
    const word = appData.vocab.find((item) => item.id === button.dataset.reviewWord);
    if (!word) return;
    showView("study");
    requestAnimationFrame(() => {
      currentCard = word;
      renderSelectedCard(word);
      setStatus(`Manual review: ${word.terms[Number($("studyLanguage").value || 0)] || word.terms.find(Boolean)}`);
      $("flashcard").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
  $("manualLabel").addEventListener("change", () => {
    manualVisibleCount = MANUAL_BATCH_SIZE;
    renderManualReviewList();
  });
  $("resetProgress").addEventListener("click", async () => {
    profileData.progress = {};
    profileData.reviews = [];
    profileData.stats = structuredClone(defaultProfileData.stats);
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
  $("profileName").addEventListener("keydown", (event) => {
    if (event.key === "Enter") saveProfile();
  });
  $("saveProfile").addEventListener("click", async () => {
    await saveProfile();
  });
  $("switchProfile").addEventListener("click", () => {
    setProfileMode("resume");
    $("profileName").focus();
    renderProfileGate(true);
  });
  $("copyProfile").addEventListener("click", async () => {
    if (!profileData.profile.name) return;
    await navigator.clipboard.writeText(profileData.profile.name);
    setStatus(`Copied profile name: ${profileData.profile.name}`);
  });
  $("profileTargetLanguage").addEventListener("change", () => {
    profileData.profile.targetLanguageIndex = Number($("profileTargetLanguage").value || 0);
    $("studyLanguage").value = String(profileData.profile.targetLanguageIndex);
    renderStudy();
  });
}

async function saveProfile() {
  try {
    const name = $("profileName").value.trim();
    if (!name) {
      setStatus("Enter a unique profile name.");
      return;
    }
    const profileId = profileIdFromName(name);
    const previousProfileId = profileData.profile.id;
    const targetLanguageIndex = Number($("profileTargetLanguage").value || 0);
    if (cloud) {
      const remote = await cloud.loadProfile(profileId);
      if (profileMode === "create" && remote) {
        setStatus("That profile name is already taken. Use another name or choose Use name.");
        logDebug("profile:create-name-taken", { name, profileId });
        return;
      }
      if (remote) {
        profileData = pickProfileData(remote);
      } else if (previousProfileId !== profileId) {
        profileData.progress = {};
        profileData.reviews = [];
      }
      profileData.profile = { ...profileData.profile, name, id: profileId, code: profileId, targetLanguageIndex };
    } else if (previousProfileId !== profileId) {
      profileData = {
        ...structuredClone(defaultProfileData),
        profile: { name, id: profileId, code: profileId, cloudUserId: profileData.profile.cloudUserId, targetLanguageIndex },
      };
    } else {
      profileData.profile = { ...profileData.profile, name, id: profileId, code: profileId, targetLanguageIndex };
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
  const labelColumnIndex = first.indexOf("labels");
  const hasLabelColumn = labelColumnIndex >= 0;
  const hasHeader = hasCategoryColumn || first.includes("lang1") || first.includes("language 1") || appData.languages.some((lang) => first.includes(lang.toLowerCase()));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const existing = new Map(appData.vocab.map((word) => [word.key, word]));
  let added = 0;
  let updated = 0;
  const touchedCategories = new Set();

  for (const row of dataRows) {
    const rowCategory = hasCategoryColumn ? row[0] : $("categoryName").value;
    const category = upsertCategory(rowCategory);
    const labels = hasLabelColumn ? upsertLabels(row[labelColumnIndex] || "") : upsertLabels($("labelNames").value);
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
      labelIds: labels.map((label) => label.id),
      labelNames: labels.map((label) => label.name),
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
  $("profileCode").value = profileData.profile.id || profileData.profile.code;
  $("languageNames").value = appData.languages.join(", ");
  if (!$("categoryName").value) $("categoryName").value = appData.categories[0]?.name || "General";
  if (!statusMessage) {
    $("syncStatus").textContent = profileData.profile.id
      ? `${cloud ? "Cloud" : "Local"} profile: ${profileData.profile.name}`
      : cloud ? "Cloud sync ready" : "Local profile";
  }
  renderStudyLanguage();
  renderProfileTargetLanguage();
  renderStudyCategory();
  renderStudyLabel();
  renderManualLabel();
  renderStudy();
  renderTracker();
  renderVocabTable();
  renderManualReviewList();
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
  renderProfileGate(true);
}

function renderProfileGate(forceOpen = false) {
  const hasProfile = Boolean(profileData.profile.id || profileData.profile.code);
  $("profileWelcome").classList.toggle("hidden", hasProfile && !forceOpen);
  $("activeProfileBar").classList.toggle("hidden", !hasProfile || forceOpen);
  document.querySelector(".study-layout")?.classList.toggle("hidden", !hasProfile || forceOpen);
  $("createProfileMode").classList.toggle("active", profileMode === "create");
  $("resumeProfileMode").classList.toggle("active", profileMode === "resume");
  $("saveProfile").textContent = profileMode === "create" ? "Create profile" : "Resume learning";
  $("activeProfileName").textContent = profileData.profile.name || "My profile";
  $("activeProfileCode").textContent = profileData.profile.name ? `Name: ${profileData.profile.name}` : "";
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
  const selected = select.value || String(profileData.profile.targetLanguageIndex || 0);
  select.innerHTML = appData.languages.map((lang, index) => `<option value="${index}">${escapeHtml(lang)}</option>`).join("");
  select.value = appData.languages[selected] ? selected : "0";
}

function renderProfileTargetLanguage() {
  const select = $("profileTargetLanguage");
  const selected = String(profileData.profile.targetLanguageIndex || 0);
  select.innerHTML = appData.languages.map((lang, index) => `<option value="${index}">${escapeHtml(lang)}</option>`).join("");
  select.value = appData.languages[selected] ? selected : "0";
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

function renderStudyLabel() {
  const select = $("studyLabel");
  const selected = select.value || "all";
  select.innerHTML = [
    '<option value="all">All labels</option>',
    ...appData.labels.map((label) => `<option value="${escapeHtml(label.id)}">${escapeHtml(label.name)}</option>`),
  ].join("");
  select.value = appData.labels.some((label) => label.id === selected) ? selected : "all";
}

function renderManualLabel() {
  const select = $("manualLabel");
  const selected = select.value || "all";
  select.innerHTML = [
    '<option value="all">All labels</option>',
    ...appData.labels.map((label) => `<option value="${escapeHtml(label.id)}">${escapeHtml(label.name)}</option>`),
  ].join("");
  select.value = appData.labels.some((label) => label.id === selected) ? selected : "all";
}

function renderStudy() {
  const due = dueCards();
  currentCard = due[0] || null;
  $("dueCount").textContent = due.length;
  $("newCount").textContent = appData.vocab.filter((word) => !profileData.progress[word.id]).length;
  $("knownCount").textContent = Object.values(profileData.progress).filter((item) => item.box >= 5).length;
  renderDailyGoal();

  $("emptyStudy").classList.toggle("hidden", Boolean(currentCard));
  $("flashcard").classList.toggle("hidden", !currentCard);
  $("answerPanel").classList.add("hidden");
  if (!currentCard) {
    renderEmptyStudyMessage();
    return;
  }

  renderSelectedCard(currentCard);
}

function renderSelectedCard(card) {
  const promptIndex = Number($("studyLanguage").value || profileData.profile.targetLanguageIndex || 0);
  $("emptyStudy").classList.add("hidden");
  $("flashcard").classList.remove("hidden");
  $("answerPanel").classList.add("hidden");
  $("cardPrompt").textContent = card.terms[promptIndex] || card.terms.find(Boolean);
  const progress = profileData.progress[card.id] || { box: 1 };
  $("cardBox").textContent = `Box ${progress.box}`;
  $("answerList").innerHTML = card.terms.map((term, index) => `
    <dt>${escapeHtml(appData.languages[index] || `Lang ${index + 1}`)}</dt>
    <dd>${escapeHtml(term || "-")}</dd>
  `).join("");
}

function renderEmptyStudyMessage() {
  const mode = $("studyMode").value || "daily";
  const title = $("emptyStudy").querySelector("h2");
  const message = $("emptyStudy").querySelector("p");
  title.textContent = "No words due";
  message.textContent = mode === "daily" && todayReviewCount() >= DAILY_GOAL
    ? "Daily quest is complete. You can keep going with Weekly review, All due, New words, or Manual review."
    : "Add vocabulary in Admin or come back when cards are scheduled.";
}

function dueCards() {
  const now = Date.now();
  const categoryId = $("studyCategory").value || "all";
  const labelId = $("studyLabel").value || "all";
  const mode = $("studyMode").value || "daily";
  const cards = appData.vocab.filter((word) => {
    if (categoryId !== "all" && word.categoryId !== categoryId) return false;
    if (labelId !== "all" && !(word.labelIds || []).includes(labelId)) return false;
    const progress = profileData.progress[word.id];
    if (mode === "new") return !progress;
    if (mode === "weekly") return !progress || progress.dueAt <= now + 7 * 86400000;
    return !progress || progress.dueAt <= now;
  });
  return sortStudyCards(cards);
}

function sortStudyCards(cards) {
  const order = $("studyOrder").value || "random";
  const promptIndex = Number($("studyLanguage").value || profileData.profile.targetLanguageIndex || 0);
  const scoreRank = { again: 0, hard: 1, good: 2, easy: 3 };
  const unseen = (word) => profileData.progress[word.id] ? 1 : 0;
  const lastScore = (word) => profileData.progress[word.id]?.lastScore || "";
  const dueAt = (word) => profileData.progress[word.id]?.dueAt || 0;
  const alpha = (a, b) => String(a.terms[promptIndex] || "").localeCompare(String(b.terms[promptIndex] || ""));
  const random = (a, b) => dailyCardRank(a.id) - dailyCardRank(b.id);
  const sorted = [...cards];

  if (order === "alphabetical") return sorted.sort(alpha);
  if (order === "new-first") return sorted.sort((a, b) => unseen(a) - unseen(b) || alpha(a, b));
  if (order === "hard-first") return sorted.sort((a, b) => (lastScore(a) === "hard" ? 0 : 1) - (lastScore(b) === "hard" ? 0 : 1) || random(a, b));
  if (order === "again-first") return sorted.sort((a, b) => (lastScore(a) === "again" ? 0 : 1) - (lastScore(b) === "again" ? 0 : 1) || random(a, b));
  if (order === "easy-first") return sorted.sort((a, b) => (lastScore(a) === "easy" ? 0 : 1) - (lastScore(b) === "easy" ? 0 : 1) || random(a, b));
  if (order === "passed-first") return sorted.sort((a, b) => (lastScore(a) === "good" ? 0 : 1) - (lastScore(b) === "good" ? 0 : 1) || random(a, b));
  if (order === "due-first") return sorted.sort((a, b) => dueAt(a) - dueAt(b) || random(a, b));
  if (order === "random") return sorted.sort(random);
  return sorted.sort((a, b) => (scoreRank[lastScore(a)] ?? 9) - (scoreRank[lastScore(b)] ?? 9) || random(a, b));
}

async function review(score) {
  if (!currentCard) return;
  const previous = profileData.progress[currentCard.id] || {
    box: 1,
    correct: 0,
    total: 0,
    lapses: 0,
  };
  const outcome = applyLeitnerOutcome(previous.box, score);
  const dueAt = Date.now() + BOX_INTERVALS[outcome.box] * 86400000;
  const passed = score !== "again";
  profileData.progress[currentCard.id] = {
    box: outcome.box,
    dueAt,
    correct: previous.correct + (passed ? 1 : 0),
    total: previous.total + 1,
    lapses: previous.lapses + (passed ? 0 : 1),
    lastScore: score,
    lastReviewedAt: Date.now(),
  };
  profileData.reviews.push({
    wordId: currentCard.id,
    score,
    boxBefore: previous.box,
    boxAfter: outcome.box,
    date: todayKey(),
    at: Date.now(),
  });
  updateGamification(score);
  await saveProfileData();
}

function renderTracker() {
  const reviews = profileData.reviews;
  const correct = reviews.filter((review) => review.score !== "again").length;
  const stats = { ...defaultProfileData.stats, ...profileData.stats };
  $("totalWords").textContent = appData.vocab.length;
  $("reviewedToday").textContent = reviews.filter((review) => review.date === todayKey()).length;
  $("accuracyRate").textContent = reviews.length ? `${Math.round((correct / reviews.length) * 100)}%` : "0%";
  $("streakDays").textContent = stats.streak || calculateStreak(reviews);
  $("pointsTotal").textContent = stats.points;
  $("levelNumber").textContent = calculateLevel(stats.points);
  renderDailyGoal();
  renderGamificationDashboard();

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

function renderDailyGoal() {
  const reviewed = todayReviewCount();
  const progress = Math.min(100, Math.round((reviewed / DAILY_GOAL) * 100));
  $("dailyGoalText").textContent = `${Math.min(reviewed, DAILY_GOAL)}/${DAILY_GOAL}`;
  $("dailyGoalBar").style.width = `${progress}%`;
}

function renderManualReviewList() {
  const target = $("manualReviewList");
  if (!target) return;
  const counts = manualReviewCounts();
  document.querySelectorAll(".manual-filter").forEach((button) => {
    button.classList.toggle("active", button.dataset.filter === manualReviewFilter);
    button.textContent = `${manualFilterLabel(button.dataset.filter)} (${counts[button.dataset.filter] || 0})`;
  });
  const words = appData.vocab.filter((word) => {
    if (manualReviewFilter === "all") return true;
    return profileData.progress[word.id]?.lastScore === manualReviewFilter;
  }).filter((word) => {
    const labelId = $("manualLabel").value || "all";
    return labelId === "all" || (word.labelIds || []).includes(labelId);
  });
  if (!words.length) {
    target.innerHTML = `
      <div class="manual-empty">
        <strong>No words match this filter yet.</strong>
        <p class="hint">${manualEmptyHint()}</p>
      </div>
    `;
    return;
  }
  const visibleWords = words.slice(0, manualVisibleCount);
  target.innerHTML = visibleWords.map((word) => {
    const promptIndex = Number($("studyLanguage").value || profileData.profile.targetLanguageIndex || 0);
    const prompt = word.terms[promptIndex] || word.terms.find(Boolean) || "-";
    const translations = word.terms
      .map((term, index) => index === promptIndex ? "" : term)
      .filter(Boolean)
      .join(" / ");
    return `
      <div class="manual-row">
        <div class="manual-word">
          <strong>${escapeHtml(prompt)}</strong>
          <span>${escapeHtml(translations || "No translation")}</span>
        </div>
        <button class="primary" type="button" data-review-word="${escapeHtml(word.id)}">Review</button>
      </div>
    `;
  }).join("") + (words.length > visibleWords.length ? `
    <button class="manual-load-more" type="button" data-load-more-manual>
      Load ${Math.min(MANUAL_BATCH_SIZE, words.length - visibleWords.length)} more
    </button>
  ` : "");
}

function manualReviewCounts() {
  const counts = { all: appData.vocab.length, good: 0, hard: 0, easy: 0, again: 0 };
  appData.vocab.forEach((word) => {
    const score = profileData.progress[word.id]?.lastScore;
    if (Object.hasOwn(counts, score)) counts[score] += 1;
  });
  return counts;
}

function manualFilterLabel(filter) {
  if (filter === "good") return "Passed";
  if (filter === "hard") return "Hard";
  if (filter === "easy") return "Easy";
  if (filter === "again") return "Not passed";
  return "All";
}

function manualEmptyHint() {
  if (!appData.vocab.length) return "No shared vocabulary has been added yet.";
  if (manualReviewFilter === "all") return "Try changing the label filter or ask admin to add vocabulary.";
  return "A word appears here after you review it and choose this result.";
}

function scoreLabel(score) {
  if (score === "again") return "Not passed";
  if (score === "hard") return "Hard";
  if (score === "easy") return "Easy";
  if (score === "good") return "Passed";
  return "New";
}

function renderGamificationDashboard() {
  const reviewed = todayReviewCount();
  const dailyProgress = Math.min(100, Math.round((reviewed / DAILY_GOAL) * 100));
  $("dailyQuestText").textContent = `${Math.min(reviewed, DAILY_GOAL)} of ${DAILY_GOAL} reviews`;
  $("dailyQuestReward").textContent = reviewed >= DAILY_GOAL ? "claimed" : "+20 XP";
  $("dailyQuestBar").style.width = `${dailyProgress}%`;

  const mastered = Object.values(profileData.progress).filter((item) => item.box >= 5).length;
  const masteryPercent = appData.vocab.length ? Math.round((mastered / appData.vocab.length) * 100) : 0;
  $("masteryText").textContent = `${mastered} mastered`;
  $("masteryPercent").textContent = `${masteryPercent}%`;
  $("masteryBar").style.width = `${masteryPercent}%`;

  const level = calculateLevel(profileData.stats.points);
  const currentFloor = levelXpFloor(level);
  const nextFloor = levelXpFloor(level + 1);
  const levelProgress = Math.round(((profileData.stats.points - currentFloor) / Math.max(1, nextFloor - currentFloor)) * 100);
  $("levelProgressText").textContent = `${Math.max(0, nextFloor - profileData.stats.points)} XP needed`;
  $("levelTitle").textContent = levelTitle(level);
  $("levelBar").style.width = `${Math.max(0, Math.min(100, levelProgress))}%`;

  renderWeekDots();
  renderBadges(mastered);
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

function todayReviewCount() {
  return profileData.reviews.filter((review) => review.date === todayKey()).length;
}

function updateGamification(score) {
  const today = todayKey();
  const yesterday = dateOffsetKey(-1);
  const stats = { ...defaultProfileData.stats, ...profileData.stats };
  if (stats.lastReviewDate !== today) {
    stats.streak = stats.lastReviewDate === yesterday ? stats.streak + 1 : 1;
    stats.lastReviewDate = today;
  }
  stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
  stats.points += scorePoints(score);
  const reviewedToday = todayReviewCount();
  if (reviewedToday === DAILY_GOAL && !dailyBonusClaimed(today)) stats.points += 20;
  profileData.stats = stats;
}

function scorePoints(score) {
  return XP_BY_SCORE[score] || XP_BY_SCORE.good;
}

function calculateLevel(points) {
  let level = 1;
  while (points >= levelXpFloor(level + 1)) level += 1;
  return level;
}

function levelXpFloor(level) {
  return Math.pow(Math.max(0, level - 1), 2) * 60;
}

function levelTitle(level) {
  if (level >= 10) return "Fluent builder";
  if (level >= 7) return "Memory maker";
  if (level >= 4) return "Steady learner";
  return "Starter";
}

function dailyBonusClaimed(date) {
  return profileData.reviews.filter((review) => review.date === date).length > DAILY_GOAL;
}

function renderWeekDots() {
  const reviewDays = new Set(profileData.reviews.map((review) => review.date));
  const labels = ["M", "T", "W", "T", "F", "S", "S"];
  const monday = startOfWeek(new Date());
  $("weekDots").innerHTML = labels.map((label, index) => {
    const date = new Date(monday);
    date.setDate(monday.getDate() + index);
    const done = reviewDays.has(date.toISOString().slice(0, 10));
    return `<span class="week-dot ${done ? "done" : ""}">${label}</span>`;
  }).join("");
}

function renderBadges(mastered) {
  const reviews = profileData.reviews;
  const stats = { ...defaultProfileData.stats, ...profileData.stats };
  const badges = [
    { name: "First step", earned: reviews.length >= 1 },
    { name: "Daily 10", earned: todayReviewCount() >= DAILY_GOAL },
    { name: "3-day rhythm", earned: stats.streak >= 3 },
    { name: "7-day rhythm", earned: stats.streak >= 7 },
    { name: "50 reviews", earned: reviews.length >= 50 },
    { name: "10 mastered", earned: mastered >= 10 },
  ];
  $("badgeList").innerHTML = badges.map((badge) => (
    `<span class="badge ${badge.earned ? "earned" : ""}">${escapeHtml(badge.name)}</span>`
  )).join("");
}

function startOfWeek(date) {
  const next = new Date(date);
  const day = (next.getDay() + 6) % 7;
  next.setDate(next.getDate() - day);
  next.setHours(0, 0, 0, 0);
  return next;
}

function dateOffsetKey(offsetDays) {
  const date = new Date();
  date.setDate(date.getDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

function renderVocabTable() {
  $("vocabHead").innerHTML = `<tr><th>Category</th><th>Labels</th>${appData.languages.map((lang) => `<th>${escapeHtml(lang)}</th>`).join("")}<th>Box</th></tr>`;
  $("vocabTable").innerHTML = appData.vocab.map((word) => {
    const box = profileData.progress[word.id]?.box || 1;
    return `<tr><td>${escapeHtml(word.categoryName || "General")}</td><td>${escapeHtml((word.labelNames || []).join(", "))}</td>${word.terms.map((term) => `<td>${escapeHtml(term)}</td>`).join("")}<td>${box}</td></tr>`;
  }).join("");
}

function downloadCsv() {
  const rows = [["Category", ...appData.languages, "Labels"], ...appData.vocab.map((word) => [word.categoryName || "General", ...word.terms, (word.labelNames || []).join("; ")])];
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
  const labels = mergeLabels(remote.labels, local.labels);
  const vocab = new Map(normalizeVocab(remote.vocab, categories, labels).map((word) => [word.key, word]));
  normalizeVocab(local.vocab, categories, labels).forEach((word) => vocab.set(word.key, word));
  return {
    languages: local.languages.length === 3 ? local.languages : remote.languages,
    categories,
    labels,
    vocab: [...vocab.values()],
  };
}

function mergeProfileData(local, remote) {
  return {
    profile: local.profile,
    progress: { ...(remote.progress || {}), ...(local.progress || {}) },
    reviews: [...(remote.reviews || []), ...(local.reviews || [])],
    stats: {
      ...defaultProfileData.stats,
      ...(remote.stats || {}),
      points: Math.max(remote.stats?.points || 0, local.stats?.points || 0),
      streak: Math.max(remote.stats?.streak || 0, local.stats?.streak || 0),
      bestStreak: Math.max(remote.stats?.bestStreak || 0, local.stats?.bestStreak || 0),
      lastReviewDate: [remote.stats?.lastReviewDate, local.stats?.lastReviewDate].filter(Boolean).sort().at(-1) || "",
    },
  };
}

function applyLeitnerOutcome(currentBox, score) {
  const box = Math.max(1, Math.min(5, Number(currentBox) || 1));
  if (score === "again") return { box: 1 };
  if (score === "hard") return { box: Math.max(1, box - 1) };
  if (score === "easy") return { box: Math.min(5, box + 2) };
  return { box: Math.min(5, box + 1) };
}

function dailyCardRank(wordId) {
  const seed = `${profileData.profile.id || "local"}|${todayKey()}|${wordId}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function profileIdFromName(name) {
  return slugify(name).slice(0, 80);
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

function upsertLabels(value) {
  return splitLabels(value).map((name) => {
    const existing = appData.labels.find((label) => label.name.toLowerCase() === name.toLowerCase());
    if (existing) return existing;
    const label = { id: uniqueLabelId(name), name };
    appData.labels.push(label);
    return label;
  });
}

function uniqueLabelId(name) {
  const base = slugify(name);
  const usedIds = new Set(appData.labels.map((label) => label.id));
  let next = base;
  let index = 2;
  while (usedIds.has(next)) {
    next = `${base}-${index}`;
    index += 1;
  }
  return next;
}

function splitLabels(value) {
  return String(value || "")
    .split(/[;,]/)
    .map((label) => label.trim())
    .filter(Boolean);
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

function normalizeLabels(labels) {
  const source = Array.isArray(labels) ? labels : [];
  const seen = new Set();
  return source.map((label) => {
    const name = String(label.name || "").trim();
    if (!name) return null;
    let id = String(label.id || slugify(name)).trim() || slugify(name);
    while (seen.has(id)) id = `${id}-copy`;
    seen.add(id);
    return { id, name };
  }).filter(Boolean);
}

function mergeLabels(remote = [], local = []) {
  const byName = new Map();
  [...normalizeLabels(remote), ...normalizeLabels(local)].forEach((label) => {
    byName.set(label.name.toLowerCase(), label);
  });
  return [...byName.values()];
}

function collectLabelsFromVocab(vocab) {
  const labels = [];
  (Array.isArray(vocab) ? vocab : []).forEach((word) => {
    (word.labelNames || []).forEach((name) => {
      if (name) labels.push({ id: slugify(name), name });
    });
  });
  return labels;
}

function normalizeVocab(vocab, categories, labels = []) {
  const categoryMap = new Map(categories.map((category) => [category.id, category]));
  const labelMap = new Map(labels.map((label) => [label.id, label]));
  const fallback = categories[0] || defaultAppData.categories[0];
  return Array.isArray(vocab) ? vocab.map((word) => {
    const category = categoryMap.get(word.categoryId) || fallback;
    const labelIds = Array.isArray(word.labelIds) ? word.labelIds : [];
    const labelNames = Array.isArray(word.labelNames) ? word.labelNames : [];
    const normalizedLabels = [
      ...labelIds.map((id) => labelMap.get(id)).filter(Boolean),
      ...labelNames.map((name) => labels.find((label) => label.name.toLowerCase() === String(name).toLowerCase())).filter(Boolean),
    ];
    const uniqueLabels = [...new Map(normalizedLabels.map((label) => [label.id, label])).values()];
    const terms = Array.isArray(word.terms) ? word.terms.slice(0, 3) : [];
    while (terms.length < 3) terms.push("");
    return {
      id: word.id || uid(),
      key: normalizeKey(terms, category.id),
      terms,
      categoryId: category.id,
      categoryName: category.name,
      labelIds: uniqueLabels.map((label) => label.id),
      labelNames: uniqueLabels.map((label) => label.name),
    };
  }) : [];
}

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "general";
}
