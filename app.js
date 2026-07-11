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
const todayKey = () => new Date().toISOString().slice(0, 10);
const uid = () => crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;

const defaultState = {
  profile: { name: "My profile", code: "", cloudUserId: "" },
  languages: ["English", "Swedish", "Persian"],
  vocab: [],
  progress: {},
  reviews: [],
};

let state = loadLocal();
let currentCard = null;
let cloud = null;

const $ = (id) => document.getElementById(id);

init();

async function init() {
  bindNavigation();
  bindStudy();
  bindAdmin();
  bindProfile();
  await initCloud();
  render();
}

function loadLocal() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return structuredClone(defaultState);
  try {
    return { ...structuredClone(defaultState), ...JSON.parse(raw) };
  } catch {
    return structuredClone(defaultState);
  }
}

async function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (cloud && state.profile.code) {
    await cloud.save(state);
  }
  render();
}

async function initCloud() {
  if (!firebaseConfig.apiKey || !firebaseConfig.projectId) {
    $("syncStatus").textContent = "Local profile";
    return;
  }

  const [{ initializeApp }, { getAuth, signInAnonymously, onAuthStateChanged }, firestore] = await Promise.all([
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js"),
    import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js"),
  ]);

  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = firestore.getFirestore(app);
  await signInAnonymously(auth);
  await new Promise((resolve) => onAuthStateChanged(auth, resolve));
  state.profile.cloudUserId = auth.currentUser.uid;

  cloud = {
    async load(code) {
      const ref = firestore.doc(db, "profiles", code);
      const snap = await firestore.getDoc(ref);
      return snap.exists() ? snap.data().state : null;
    },
    async save(nextState) {
      const ref = firestore.doc(db, "profiles", nextState.profile.code);
      await firestore.setDoc(ref, {
        state: nextState,
        updatedAt: firestore.serverTimestamp(),
      });
    },
  };
  $("syncStatus").textContent = "Cloud sync ready";
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
  $("revealAnswer").addEventListener("click", () => $("answerPanel").classList.remove("hidden"));
  $("againBtn").addEventListener("click", () => review("again"));
  $("hardBtn").addEventListener("click", () => review("hard"));
  $("goodBtn").addEventListener("click", () => review("good"));
  $("easyBtn").addEventListener("click", () => review("easy"));
  $("resetProgress").addEventListener("click", async () => {
    state.progress = {};
    state.reviews = [];
    await save();
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
      state.languages = names;
      await save();
    }
  });
  $("downloadCsv").addEventListener("click", downloadCsv);
  $("clearVocab").addEventListener("click", async () => {
    state.vocab = [];
    state.progress = {};
    await save();
  });
}

function bindProfile() {
  $("saveProfile").addEventListener("click", async () => {
    state.profile.name = $("profileName").value.trim() || "My profile";
    state.profile.code = $("profileCode").value.trim() || uid().slice(0, 8);
    if (cloud) {
      const remote = await cloud.load(state.profile.code);
      if (remote) state = mergeState(state, remote);
    }
    await save();
  });
  $("copyProfile").addEventListener("click", async () => {
    if (!state.profile.code) return;
    await navigator.clipboard.writeText(state.profile.code);
  });
}

async function importCsv(text) {
  const rows = parseCsv(text).filter((row) => row.some(Boolean));
  if (!rows.length) return;

  const first = rows[0].map((cell) => cell.toLowerCase());
  const hasHeader = first.includes("lang1") || first.includes("language 1") || state.languages.some((lang) => first.includes(lang.toLowerCase()));
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const existing = new Map(state.vocab.map((word) => [word.key, word]));
  let added = 0;
  let updated = 0;

  for (const row of dataRows) {
    const terms = row.slice(0, 3).map((cell) => cell.trim());
    if (terms.filter(Boolean).length < 2) continue;
    while (terms.length < 3) terms.push("");
    const key = normalizeKey(terms);
    const next = { id: existing.get(key)?.id || uid(), key, terms };
    if (existing.has(key)) updated += 1;
    else added += 1;
    existing.set(key, next);
  }

  state.vocab = [...existing.values()].sort((a, b) => a.terms[0].localeCompare(b.terms[0]));
  $("importResult").textContent = `Imported ${added} new and ${updated} updated words.`;
  await save();
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

function normalizeKey(terms) {
  return terms.map((term) => term.trim().toLowerCase()).join("|");
}

function render() {
  $("profileName").value = state.profile.name;
  $("profileCode").value = state.profile.code;
  $("languageNames").value = state.languages.join(", ");
  $("syncStatus").textContent = state.profile.code
    ? `${cloud ? "Cloud" : "Local"} profile: ${state.profile.code}`
    : cloud ? "Cloud sync ready" : "Local profile";
  renderStudyLanguage();
  renderStudy();
  renderTracker();
  renderVocabTable();
}

function renderStudyLanguage() {
  const select = $("studyLanguage");
  const selected = select.value || "0";
  select.innerHTML = state.languages.map((lang, index) => `<option value="${index}">${escapeHtml(lang)}</option>`).join("");
  select.value = selected;
}

function renderStudy() {
  const due = dueCards();
  currentCard = due[0] || null;
  $("dueCount").textContent = due.length;
  $("newCount").textContent = state.vocab.filter((word) => !state.progress[word.id]).length;
  $("knownCount").textContent = Object.values(state.progress).filter((item) => item.box >= 5).length;

  $("emptyStudy").classList.toggle("hidden", Boolean(currentCard));
  $("flashcard").classList.toggle("hidden", !currentCard);
  $("answerPanel").classList.add("hidden");
  if (!currentCard) return;

  const promptIndex = Number($("studyLanguage").value || 0);
  $("cardPrompt").textContent = currentCard.terms[promptIndex] || currentCard.terms.find(Boolean);
  const progress = state.progress[currentCard.id] || { box: 1 };
  $("cardBox").textContent = `Box ${progress.box}`;
  $("answerList").innerHTML = currentCard.terms.map((term, index) => `
    <dt>${escapeHtml(state.languages[index] || `Lang ${index + 1}`)}</dt>
    <dd>${escapeHtml(term || "-")}</dd>
  `).join("");
}

function dueCards() {
  const now = Date.now();
  return state.vocab.filter((word) => {
    const progress = state.progress[word.id];
    return !progress || progress.dueAt <= now;
  });
}

async function review(score) {
  if (!currentCard) return;
  const previous = state.progress[currentCard.id] || { box: 1, correct: 0, total: 0 };
  const delta = { again: -1, hard: 0, good: 1, easy: 2 }[score];
  const box = score === "again" ? 1 : Math.max(1, Math.min(5, previous.box + delta));
  const dueAt = Date.now() + BOX_INTERVALS[box] * 86400000;
  const correct = score === "again" ? previous.correct : previous.correct + 1;
  state.progress[currentCard.id] = { box, dueAt, correct, total: previous.total + 1, lastScore: score };
  state.reviews.push({ wordId: currentCard.id, score, date: todayKey(), at: Date.now() });
  await save();
}

function renderTracker() {
  const reviews = state.reviews;
  const correct = reviews.filter((review) => review.score !== "again").length;
  $("totalWords").textContent = state.vocab.length;
  $("reviewedToday").textContent = reviews.filter((review) => review.date === todayKey()).length;
  $("accuracyRate").textContent = reviews.length ? `${Math.round((correct / reviews.length) * 100)}%` : "0%";
  $("streakDays").textContent = calculateStreak(reviews);

  const counts = [1, 2, 3, 4, 5].map((box) => Object.values(state.progress).filter((item) => item.box === box).length);
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
  $("vocabHead").innerHTML = `<tr>${state.languages.map((lang) => `<th>${escapeHtml(lang)}</th>`).join("")}<th>Box</th></tr>`;
  $("vocabTable").innerHTML = state.vocab.map((word) => {
    const box = state.progress[word.id]?.box || 1;
    return `<tr>${word.terms.map((term) => `<td>${escapeHtml(term)}</td>`).join("")}<td>${box}</td></tr>`;
  }).join("");
}

function downloadCsv() {
  const rows = [state.languages, ...state.vocab.map((word) => word.terms)];
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

function mergeState(local, remote) {
  const progress = { ...remote.progress, ...local.progress };
  const vocab = new Map(remote.vocab.map((word) => [word.key, word]));
  local.vocab.forEach((word) => vocab.set(word.key, word));
  return {
    ...remote,
    profile: local.profile,
    languages: local.languages.length === 3 ? local.languages : remote.languages,
    vocab: [...vocab.values()],
    progress,
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
