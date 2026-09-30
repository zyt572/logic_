const STORAGE_USERS = 'logic_daily_users_v1';
const STORAGE_SESSION = 'logic_daily_session_v1';
const STORAGE_USER_IMPORT = 'logic_daily_user_import_v1';

const DAILY_MIN = 3;
const DAILY_MAX = 5;
const EXTRA_MAX = 5;

const POINTS = {
  dailyCorrect: 10,
  extraCorrect: 5,
  wrongReviewCorrect: 2,
  checkinBase: 5,
  checkinStreakBonus: 2,
  checkinStreakBonusMax: 10
};

const RANKS = [
  { name: '逻辑新手', icon: '', min: 0 },
  { name: '逻辑学徒', icon: '', min: 100 },
  { name: '推理行者', icon: '', min: 300 },
  { name: '逻辑大师', icon: '', min: 600 },
  { name: '推理宗师', icon: '', min: 1000 }
];

const state = {
  user: null,
  authMode: 'login',
  tab: 'daily',
  daily: null,
  current: null,
  selected: null,
  answering: false,
  wrongs: [],
  extraMax: EXTRA_MAX
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

document.addEventListener('DOMContentLoaded', init);

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {
      // GitHub Pages / 本地静态环境不支持时忽略
    });
  });
}

/* ------------------ 本地存储 ------------------ */

function loadUsers() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_USERS) || '{}') || {};
  } catch (err) {
    return {};
  }
}

function saveUsers(users) {
  localStorage.setItem(STORAGE_USERS, JSON.stringify(users));
}

function saveCurrentUser() {
  if (!state.user) return;
  const users = loadUsers();
  users[state.user.username] = state.user;
  saveUsers(users);
}

function ensureUserShape(user) {
  user.points ??= 0;
  user.stats ??= { answered: 0, correct: 0 };
  user.stats.answered ??= 0;
  user.stats.correct ??= 0;
  user.wrongQuestions ??= [];
  user.seenQuestionIds ??= [];
  user.rewarded ??= {};
  user.checkinStreak ??= 0;
  user.lastCheckinDate ??= null;
  user.daily ??= null;

  if (user.daily) {
    user.daily.answers ||= {};
    user.daily.extras ||= [];
    user.daily.extraAnswers ||= {};
    user.daily.extraCount ??= 0;
  }
}

/* ------------------ 密码 / 日期 / 随机 ------------------ */

function randomSalt() {
  return `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

async function hashPassword(password, salt) {
  const text = `${salt}:${password}`;

  if (window.crypto?.subtle && window.TextEncoder) {
    const data = new TextEncoder().encode(text);
    const digest = await window.crypto.subtle.digest('SHA-256', data);
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join('');
  }

  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fallback-${(hash >>> 0).toString(16)}`;
}

function todayKey() {
  const date = new Date();
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function shiftDateKey(key, delta) {
  const [year, month, day] = String(key).split('-').map(Number);
  const date = new Date(year, month - 1, day + delta);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')
  ].join('-');
}

function hashString(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let value = seed;
  return function random() {
    value += 0x6d2b79f5;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleWithRandom(list, random) {
  const result = [...list];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function shuffleQuestionOptions(question, random = Math.random) {
  const indexed = question.options.map((option, index) => ({ option, index }));
  const shuffled = shuffleWithRandom(indexed, random);
  return {
    ...question,
    options: shuffled.map((item) => item.option),
    answerIndex: shuffled.findIndex((item) => item.index === question.answerIndex)
  };
}

/* ------------------ 题库 ------------------ */

let questionCache = null;

function cleanQuestionText(value) {
  return String(value == null ? '' : value)
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

function cleanOptionText(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

function makeChoiceQuestion(raw, sourceName) {
  const question = cleanQuestionText(raw.question || raw.title || raw.stem || '');
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map((option) => cleanOptionText(typeof option === 'string' ? option : option.text || option.label || ''))
    .filter(Boolean);

  let answerIndex = Number(raw.answerIndex);
  const answerText = cleanOptionText(raw.answer || raw.correctAnswer || raw.correct || '');

  if (!Number.isInteger(answerIndex) && answerText) {
    answerIndex = options.findIndex(
      (option) => option === answerText || option.includes(answerText) || answerText.includes(option)
    );

    if (answerIndex < 0 && /^[A-Ha-h]$/.test(answerText)) {
      const index = answerText.toUpperCase().charCodeAt(0) - 65;
      if (index >= 0 && index < options.length) answerIndex = index;
    }
  }

  if (
    !question ||
    options.length < 2 ||
    !Number.isInteger(answerIndex) ||
    answerIndex < 0 ||
    answerIndex >= options.length
  ) {
    return null;
  }

  const idSeed = raw.id ? `id_${raw.id}` : `${question}|${options.join('|')}`;

  return {
    ...raw,
    id: `q_${hashString(idSeed).toString(36)}`,
    question,
    options,
    answerIndex,
    explanation: cleanQuestionText(raw.explanation || raw.analysis || ''),
    source: raw.source || sourceName || '题库',
    sourceUrl: raw.sourceUrl || '',
    chapter: raw.chapter || ''
  };
}

function getBuiltinQuestions() {
  const raw = Array.isArray(window.LOGIC_QUESTIONS) ? window.LOGIC_QUESTIONS : [];
  return raw.map((question) => makeChoiceQuestion(question, question.source || '内置逻辑题库')).filter(Boolean);
}

function getPreloadedQA() {
  return Array.isArray(window.LOGIC_BANK_QA) ? window.LOGIC_BANK_QA : [];
}

function loadUserImportedBank() {
  try {
    const data = JSON.parse(localStorage.getItem(STORAGE_USER_IMPORT) || '[]');
    return Array.isArray(data) ? data : [];
  } catch (err) {
    return [];
  }
}

function saveUserImportedBank(list) {
  localStorage.setItem(STORAGE_USER_IMPORT, JSON.stringify(list));
  questionCache = null;
}

function makeQaChoice(item, answerPool, sourceName) {
  const question = cleanQuestionText(item.question || '');
  const correct = cleanOptionText(item.answer || '');
  if (!question || !correct) return null;

  const id = `qa_${hashString(`${question}|${correct}`).toString(36)}`;
  const random = mulberry32(hashString(id));
  const candidates = [...new Set(answerPool.map(cleanOptionText).filter((text) => text && text !== correct))];
  const distractors = shuffleWithRandom(candidates, random).slice(0, 3);

  while (distractors.length < 3) {
    distractors.push(`以上都不对（${distractors.length + 1}）`);
  }

  const options = shuffleWithRandom([correct, ...distractors], random);
  const answerIndex = options.indexOf(correct);

  return {
    id,
    question,
    options,
    answerIndex,
    explanation: cleanQuestionText(item.explanation || ''),
    source: item.source || sourceName || '导入题库',
    sourceUrl: item.sourceUrl || '',
    chapter: item.chapter || ''
  };
}

function getAllQuestions() {
  if (questionCache) return questionCache;

  const builtin = getBuiltinQuestions();
  const preloadedRaw = getPreloadedQA();
  const userRaw = loadUserImportedBank();

  const answerPool = [];

  for (const item of [...preloadedRaw, ...userRaw]) {
    const answer = cleanOptionText(item.answer || '');
    if (answer) answerPool.push(answer);
  }

  for (const question of builtin) {
    answerPool.push(question.options[question.answerIndex]);
  }

  for (const item of userRaw) {
    if (Array.isArray(item.options) && Number.isInteger(item.answerIndex) && item.options[item.answerIndex]) {
      answerPool.push(cleanOptionText(item.options[item.answerIndex]));
    }
  }

  const preloadedPlayable = preloadedRaw
    .map((item) => makeQaChoice(item, answerPool, '预置逻辑题库'))
    .filter(Boolean);

  const userPlayable = userRaw
    .map((item) => {
      if (Array.isArray(item.options) && item.options.length >= 2) {
        return makeChoiceQuestion(item, '导入题库');
      }
      return makeQaChoice(item, answerPool, '导入题库');
    })
    .filter(Boolean);

  questionCache = [...builtin, ...preloadedPlayable, ...userPlayable];
  return questionCache;
}

function getBankStats() {
  return {
    builtin: (window.LOGIC_QUESTIONS || []).length,
    preloaded: getPreloadedQA().filter((item) => item.question && item.answer).length,
    imported: loadUserImportedBank().length,
    playable: getAllQuestions().length
  };
}

/* ------------------ 导入题库 ------------------ */

function parseJsonBank(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data)
    ? data
    : Array.isArray(data.questions)
      ? data.questions
      : Array.isArray(data.data)
        ? data.data
        : [];

  return list
    .map((item) => ({
      question: cleanQuestionText(item.question || item.title || item.stem || ''),
      answer: cleanQuestionText(item.answer || item.correctAnswer || item.correct || ''),
      options: Array.isArray(item.options) ? item.options : undefined,
      answerIndex: Number.isInteger(item.answerIndex) ? item.answerIndex : undefined,
      explanation: cleanQuestionText(item.explanation || item.analysis || ''),
      chapter: item.chapter || '',
      source: item.source || '导入题库'
    }))
    .filter(Boolean)
    .filter((item) => item.question && (item.answer || (Array.isArray(item.options) && item.options.length >= 2)));
}

function splitTxtBlocks(text) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').trim();

  // 优先按空行分块：适合1. 题目\n...\n答案：...这种标准格式。
  const byBlank = normalized
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (byBlank.length > 1 && byBlank.every((block) => /答案\s*[:：]/.test(block))) {
    return byBlank;
  }

  const numbered = normalized
    .split(/\n(?=\s*\d+\s*[.．、]\s*)/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (numbered.length > 1) return numbered;
  return byBlank;
}

function parseTxtBank(text) {
  const blocks = splitTxtBlocks(text);
  const items = [];

  for (const rawBlock of blocks) {
    const block = rawBlock.replace(/^\s*\d+\s*[.．、]\s*/, '').trim();
    if (!block) continue;

    let question = '';
    let answer = '';

    let match = block.match(/^题目\s*[:：]\s*([\s\S]*?)\n\s*答案\s*[:：]\s*([\s\S]*)$/);
    if (!match) match = block.match(/^问\s*[:：]\s*([\s\S]*?)\n\s*答\s*[:：]\s*([\s\S]*)$/);

    if (match) {
      question = match[1];
      answer = match[2];
    } else {
      const index = block.search(/\n\s*答案\s*[:：]/);
      if (index >= 0) {
        question = block.slice(0, index);
        answer = block.slice(index).replace(/^\s*答案\s*[:：]\s*/, '');
      }
    }

    question = cleanQuestionText(question);
    answer = cleanQuestionText(answer);

    if (question && answer) {
      items.push({
        question,
        answer,
        explanation: '',
        chapter: '',
        source: '导入题库（TXT）'
      });
    }
  }

  return items;
}

function parseBankText(text, fileName = '') {
  const trimmed = String(text || '').trim();
  const looksLikeJson = fileName.toLowerCase().endsWith('.json') || /^[\[{]/.test(trimmed);
  return looksLikeJson ? parseJsonBank(trimmed) : parseTxtBank(trimmed);
}

async function importBankFile(file) {
  const text = await file.text();
  const parsed = parseBankText(text, file.name);

  if (!parsed.length) {
    throw new Error('没有解析到题目，请检查 TXT / JSON 格式');
  }

  const existing = loadUserImportedBank();
  const seen = new Set(
    existing.map((item) => `${item.question}||${item.answer || (item.options || []).join('|')}`)
  );

  let added = 0;

  for (const item of parsed) {
    const key = `${item.question}||${item.answer || (item.options || []).join('|')}`;
    if (seen.has(key)) continue;
    seen.add(key);
    existing.push(item);
    added += 1;
  }

  saveUserImportedBank(existing);
  return { added, total: existing.length, playable: getAllQuestions().length };
}

function bindImport() {
  const fileInput = $('#importFile');
  const importButton = $('#importBtn');
  const resetButton = $('#resetImportBtn');

  if (!fileInput || !importButton || !resetButton) return;

  importButton.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    const status = $('#importStatus');
    if (status) status.textContent = '正在解析并导入...';

    try {
      const result = await importBankFile(file);
      if (status) {
        status.textContent = `导入完成：本次新增 ${result.added} 道，自定义题库 ${result.total} 道，当前可用 ${result.playable} 道。`;
      }
      toast(`成功导入 ${result.added} 道题`, 'success');
      if (state.tab === 'profile') renderProfile();
    } catch (err) {
      if (status) status.textContent = `导入失败：${err.message}`;
      toast(err.message, 'error');
    } finally {
      fileInput.value = '';
    }
  });

  resetButton.addEventListener('click', () => {
    if (!confirm('确定清空自定义导入题库吗？内置题库和预置 237 道题不会被删除。')) return;
    saveUserImportedBank([]);
    const status = $('#importStatus');
    if (status) status.textContent = '已清空自定义导入题库。';
    toast('已清空自定义导入题库', 'success');
    if (state.tab === 'profile') renderProfile();
  });
}

/* ------------------ 段位 / 资料 ------------------ */

function getRank(points) {
  let current = RANKS[0];
  let next = null;

  for (let i = 0; i < RANKS.length; i += 1) {
    if ((points || 0) >= RANKS[i].min) {
      current = RANKS[i];
      next = RANKS[i + 1] || null;
    }
  }

  const progress = next
    ? Math.min(100, Math.round(((points - current.min) / (next.min - current.min)) * 100))
    : 100;

  return { current, next, progress };
}

function publicProfile(user) {
  ensureUserShape(user);

  const rankInfo = getRank(user.points || 0);
  const total = user.stats.answered || 0;
  const accuracy = total ? Math.round((user.stats.correct / total) * 100) : 0;
  const wrongPending = user.wrongQuestions.filter((item) => !item.mastered).length;
  const isToday = user.daily && user.daily.date === todayKey();

  return {
    username: user.username,
    points: user.points || 0,
    rank: rankInfo.current,
    nextRank: rankInfo.next,
    rankProgress: rankInfo.progress,
    streak: user.checkinStreak || 0,
    checkedInToday: user.lastCheckinDate === todayKey(),
    stats: {
      answered: total,
      correct: user.stats.correct || 0,
      accuracy,
      wrongPending
    },
    extraUsed: isToday ? user.daily.extraCount || 0 : 0,
    extraMax: EXTRA_MAX
  };
}

/* ------------------ 每日题目 ------------------ */

function ensureToday(user) {
  ensureUserShape(user);

  const today = todayKey();

  if (user.daily && user.daily.date === today) {
    return user.daily;
  }

  const random = mulberry32(hashString(`${user.username}:${today}`));
  const count = DAILY_MIN + Math.floor(random() * (DAILY_MAX - DAILY_MIN + 1));
  const seen = new Set(user.seenQuestionIds || []);

  let pool = getAllQuestions().filter((question) => !seen.has(question.id));
  if (pool.length < count) {
    pool = getAllQuestions();
  }

  const selected = shuffleWithRandom(pool, random)
    .slice(0, count)
    .map((question) => shuffleQuestionOptions(question, random));

  user.daily = {
    date: today,
    questions: selected,
    answers: {},
    extras: [],
    extraAnswers: {},
    extraCount: 0,
    createdAt: new Date().toISOString()
  };

  for (const question of selected) {
    if (!user.seenQuestionIds.includes(question.id)) {
      user.seenQuestionIds.push(question.id);
    }
  }

  saveCurrentUser();
  return user.daily;
}

function publicQuestion(question, record) {
  const base = {
    id: question.id,
    question: question.question,
    options: question.options,
    source: question.source || '',
    sourceUrl: question.sourceUrl || ''
  };

  if (record) {
    return {
      ...base,
      answered: true,
      selected: record.selected,
      correct: Boolean(record.correct),
      correctAnswer: question.answerIndex,
      explanation: question.explanation || ''
    };
  }

  return { ...base, answered: false };
}

/* ------------------ 错题 ------------------ */

function addWrongQuestion(user, question, selected) {
  const now = new Date().toISOString();
  const existing = user.wrongQuestions.find((item) => item.questionId === question.id);

  if (existing) {
    existing.question = question.question;
    existing.options = question.options;
    existing.answerIndex = question.answerIndex;
    existing.explanation = question.explanation || '';
    existing.source = question.source || '';
    existing.sourceUrl = question.sourceUrl || '';
    existing.selected = selected;
    existing.lastWrongAt = now;
    existing.wrongCount = (existing.wrongCount || 1) + 1;
    existing.mastered = false;
    return;
  }

  user.wrongQuestions.unshift({
    id: `w_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    questionId: question.id,
    question: question.question,
    options: question.options,
    answerIndex: question.answerIndex,
    explanation: question.explanation || '',
    source: question.source || '',
    sourceUrl: question.sourceUrl || '',
    selected,
    wrongAt: now,
    lastWrongAt: now,
    wrongCount: 1,
    mastered: false
  });

  if (user.wrongQuestions.length > 300) {
    user.wrongQuestions.length = 300;
  }
}

/* ------------------ 答题 / 加题 / 签到 ------------------ */

function answerQuestion(questionId, selected, mode = 'daily') {
  const user = state.user;
  const daily = ensureToday(user);
  const list = mode === 'extra' ? daily.extras : daily.questions;
  const question = list.find((item) => item.id === questionId);

  if (!question) throw new Error('没有找到这道题');
  if (!Number.isInteger(selected) || selected < 0 || selected >= question.options.length) {
    throw new Error('请选择有效答案');
  }

  const records = mode === 'extra' ? daily.extraAnswers : daily.answers;
  if (records[questionId]) throw new Error('本题已经答过了');

  const correct = selected === question.answerIndex;
  records[questionId] = { selected, correct, answeredAt: new Date().toISOString() };

  user.stats.answered = (user.stats.answered || 0) + 1;

  let pointsEarned = 0;

  if (correct) {
    user.stats.correct = (user.stats.correct || 0) + 1;

    const rewardKey = `${daily.date}:${question.id}`;
    if (!user.rewarded[rewardKey]) {
      pointsEarned = mode === 'extra' ? POINTS.extraCorrect : POINTS.dailyCorrect;
      user.points = (user.points || 0) + pointsEarned;
      user.rewarded[rewardKey] = true;
    }
  } else {
    addWrongQuestion(user, question, selected);
  }

  saveCurrentUser();
  return {
    correct,
    selected,
    correctAnswer: question.answerIndex,
    explanation: question.explanation || '',
    pointsEarned,
    profile: publicProfile(user)
  };
}

function getExtraQuestion() {
  const user = state.user;
  const daily = ensureToday(user);

  if ((daily.extraCount || 0) >= EXTRA_MAX) {
    throw new Error('今日加题次数已用完，明天再来吧');
  }

  const exclude = new Set([
    ...daily.questions.map((item) => item.id),
    ...daily.extras.map((item) => item.id)
  ]);

  let pool = getAllQuestions().filter(
    (question) => !exclude.has(question.id) && !user.seenQuestionIds.includes(question.id)
  );

  if (!pool.length) {
    pool = getAllQuestions().filter((question) => !exclude.has(question.id));
  }

  if (!pool.length) throw new Error('题库暂时没有更多题目');

  const raw = pool[Math.floor(Math.random() * pool.length)];
  const question = shuffleQuestionOptions({ ...raw, options: [...raw.options] });

  daily.extras.push(question);
  daily.extraCount = (daily.extraCount || 0) + 1;

  if (!user.seenQuestionIds.includes(question.id)) {
    user.seenQuestionIds.push(question.id);
  }

  saveCurrentUser();
  return {
    question: publicQuestion(question),
    extraUsed: daily.extraCount,
    extraMax: EXTRA_MAX
  };
}

function checkin() {
  const user = state.user;
  const today = todayKey();

  if (user.lastCheckinDate === today) {
    throw new Error('今天已经签到过了');
  }

  const yesterday = shiftDateKey(today, -1);
  user.checkinStreak = user.lastCheckinDate === yesterday ? (user.checkinStreak || 0) + 1 : 1;
  user.lastCheckinDate = today;

  const bonus = Math.min(
    POINTS.checkinStreakBonus * Math.max(0, user.checkinStreak - 1),
    POINTS.checkinStreakBonusMax
  );

  const pointsEarned = POINTS.checkinBase + bonus;
  user.points = (user.points || 0) + pointsEarned;

  saveCurrentUser();
  return { pointsEarned, profile: publicProfile(user) };
}

function reviewWrong(wrongId, selected) {
  const user = state.user;
  const wrong = user.wrongQuestions.find((item) => item.id === wrongId);

  if (!wrong) throw new Error('没有找到该错题');
  if (!Number.isInteger(selected) || selected < 0 || selected >= wrong.options.length) {
    throw new Error('请选择有效答案');
  }

  const correct = selected === wrong.answerIndex;
  let pointsEarned = 0;

  user.stats.answered = (user.stats.answered || 0) + 1;

  if (correct) {
    user.stats.correct = (user.stats.correct || 0) + 1;

    if (!wrong.mastered) {
      wrong.mastered = true;
      const rewardKey = `review:${wrong.questionId}`;

      if (!user.rewarded[rewardKey]) {
        pointsEarned = POINTS.wrongReviewCorrect;
        user.points = (user.points || 0) + pointsEarned;
        user.rewarded[rewardKey] = true;
      }
    }
  } else {
    wrong.mastered = false;
    wrong.wrongCount = (wrong.wrongCount || 1) + 1;
    wrong.lastWrongAt = new Date().toISOString();
  }

  saveCurrentUser();
  return {
    correct,
    selected,
    correctAnswer: wrong.answerIndex,
    explanation: wrong.explanation || '',
    pointsEarned,
    profile: publicProfile(user)
  };
}

/* ------------------ 登录 / 注册 ------------------ */

async function init() {
  bindAuth();
  bindNav();
  bindGameActions();
  bindImport();
  initTheme();

  const username = localStorage.getItem(STORAGE_SESSION);
  const user = username ? loadUsers()[username] : null;

  if (user) {
    ensureUserShape(user);
    state.user = user;
    enterGame();
  } else {
    showAuth();
  }
}

function bindAuth() {
  $$('[data-auth-tab]').forEach((button) => {
    button.addEventListener('click', () => setAuthMode(button.dataset.authTab));
  });

  $('#authForm').addEventListener('submit', onAuthSubmit);
}

function setAuthMode(mode) {
  state.authMode = mode;

  $$('[data-auth-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.authTab === mode);
  });

  $('#authSubmit').textContent = mode === 'login' ? '登录' : '注册';
  $('#authPassword').setAttribute('autocomplete', mode === 'login' ? 'current-password' : 'new-password');
  $('#authError').textContent = '';
}

async function onAuthSubmit(event) {
  event.preventDefault();

  const username = $('#authUsername').value.trim();
  const password = $('#authPassword').value;
  const errorBox = $('#authError');
  const submitButton = $('#authSubmit');

  if (!/^[\u4e00-\u9fa5A-Za-z0-9_]{3,16}$/.test(username)) {
    errorBox.textContent = '用户名需为3-16位中文、字母、数字或下划线';
    return;
  }

  if (password.length < 6 || password.length > 64) {
    errorBox.textContent = '密码长度需为6-64位';
    return;
  }

  submitButton.disabled = true;
  errorBox.textContent = '';

  try {
    const users = loadUsers();

    if (state.authMode === 'login') {
      const user = users[username];
      if (!user) throw new Error('用户名或密码错误');
      const passwordHash = await hashPassword(password, user.salt);
      if (passwordHash !== user.passwordHash) throw new Error('用户名或密码错误');
      ensureUserShape(user);
      state.user = user;
    } else {
      if (users[username]) throw new Error('用户名已存在');
      const salt = randomSalt();
      const passwordHash = await hashPassword(password, salt);
      users[username] = {
        username,
        salt,
        passwordHash,
        points: 0,
        stats: { answered: 0, correct: 0 },
        wrongQuestions: [],
        seenQuestionIds: [],
        rewarded: {},
        checkinStreak: 0,
        lastCheckinDate: null,
        daily: null,
        createdAt: new Date().toISOString()
      };
      state.user = users[username];
      saveUsers(users);
    }

    localStorage.setItem(STORAGE_SESSION, username);
    enterGame();
  } catch (err) {
    errorBox.textContent = err.message;
  } finally {
    submitButton.disabled = false;
  }
}

function showAuth() {
  $('#authView').classList.remove('hidden');
  $('#gameView').classList.add('hidden');
  $('#topbar').classList.add('hidden');
  $('#bottomNav').classList.add('hidden');
}

function enterGame() {
  $('#authView').classList.add('hidden');
  $('#gameView').classList.remove('hidden');
  $('#topbar').classList.remove('hidden');
  $('#bottomNav').classList.remove('hidden');

  updateProfileHeader();
  loadDaily();
}

/* ------------------ 个人资料与签到 ------------------ */

function updateProfileHeader() {
  const user = state.user;
  if (!user) return;

  ensureUserShape(user);
  const profile = publicProfile(user);
  const rank = profile.rank || RANKS[0];

  $('#rankBadge').textContent = rank.icon || '';
  $('#rankName').textContent = rank.name || '逻辑新手';
  $('#helloName').textContent = user.username;
  $('#pointsText').textContent = `${profile.points} 积分`;
  $('#streakText').textContent = `连续签到 ${profile.streak} 天`;
  $('#rankProgress').style.width = `${profile.rankProgress}%`;
  $('#wrongBadge').textContent = profile.stats.wrongPending;

  const checkedIn = Boolean(profile.checkedInToday);
  $('#checkinBtn').textContent = checkedIn ? '已签到' : '签到';
  $('#checkinBtn').disabled = checkedIn;
  $('#checkinBtn2').textContent = checkedIn ? '今日已签到' : '每日签到';
  $('#checkinBtn2').disabled = checkedIn;
}

function handleCheckin() {
  try {
    const data = checkin();
    updateProfileHeader();
    if (state.tab === 'profile') renderProfile();
    toast(`签到成功，+${data.pointsEarned} 积分`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ------------------ 今日刷题 ------------------ */

function loadDaily() {
  showLoadingQuestion();

  try {
    const daily = ensureToday(state.user);
    state.daily = {
      date: daily.date,
      questions: daily.questions.map((question) => publicQuestion(question, daily.answers[question.id])),
      progress: {
        answered: Object.keys(daily.answers).length,
        total: daily.questions.length
      },
      extras: daily.extras.map((question) => publicQuestion(question, daily.extraAnswers[question.id])),
      extraUsed: daily.extraCount || 0,
      extraMax: EXTRA_MAX
    };
    state.extraMax = EXTRA_MAX;

    $('#dailyDate').textContent = state.daily.date;
    $('#dailyProgress').textContent = `${state.daily.progress.answered}/${state.daily.progress.total}`;

    const nextQuestion = state.daily.questions.find((question) => !question.answered);

    if (nextQuestion) {
      renderQuestion(nextQuestion, 'daily');
    } else {
      renderDailySummary();
    }
  } catch (err) {
    $('#questionText').textContent = `题目加载失败：${err.message}`;
    $('#options').innerHTML = '';
    toast(err.message, 'error');
  }
}

function showLoadingQuestion() {
  state.current = null;
  state.selected = null;

  $('#questionText').textContent = '正在准备今日题目...';
  $('#options').innerHTML = '<div class="loading">请稍候，马上就来</div>';
  $('#questionSource').textContent = '';
  $('#feedbackArea').classList.add('hidden');
  $('#submitBtn').classList.add('hidden');
  $('#nextBtn').classList.add('hidden');
  $('#extraBtn').classList.add('hidden');
}

function renderQuestion(question, mode, extra = {}) {
  state.current = { question, mode, ...extra };
  state.selected = question.answered ? question.selected : null;
  state.answering = false;

  $('#questionText').textContent = question.question;
  $('#questionSource').textContent = question.source ? `来源：${question.source}` : '';

  renderOptions(question);

  if (question.answered) {
    showFeedback(question.selected, question.correctAnswer, question.correct, question.explanation, 0);
  } else {
    hideFeedback();
  }

  updateActions();

  document.querySelector('.daily-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderOptions(question) {
  const container = $('#options');
  container.innerHTML = '';

  question.options.forEach((option, index) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'option';
    button.innerHTML = `
      <span class="opt-key">${String.fromCharCode(65 + index)}</span>
      <span class="opt-text">${escapeHtml(option)}</span>
    `;

    if (state.selected === index) button.classList.add('selected');

    if (question.answered) {
      button.disabled = true;
      if (index === question.correctAnswer) button.classList.add('correct');
      else if (index === question.selected) button.classList.add('wrong');
    } else {
      button.addEventListener('click', () => selectOption(index));
    }

    container.appendChild(button);
  });

  updateSubmitState();
}

function selectOption(index) {
  if (state.current?.question?.answered) return;
  state.selected = index;

  $$('.option').forEach((button, currentIndex) => {
    button.classList.toggle('selected', currentIndex === index);
    button.classList.remove('correct', 'wrong');
  });

  updateSubmitState();
}

function updateSubmitState() {
  const button = $('#submitBtn');
  if (!button) return;

  button.disabled =
    state.selected == null ||
    state.selected === '' ||
    Boolean(state.current?.question?.answered);
}

function submitAnswer() {
  if (state.answering || state.selected == null || !state.current || state.current.question.answered) {
    return;
  }

  const { question, mode, wrongId } = state.current;
  state.answering = true;
  $('#submitBtn').disabled = true;

  try {
    const data = mode === 'review'
      ? reviewWrong(wrongId, state.selected)
      : answerQuestion(question.id, state.selected, mode);

    question.answered = true;
    question.selected = state.selected;
    question.correct = data.correct;
    question.correctAnswer = data.correctAnswer;
    question.explanation = data.explanation;

    if (mode === 'review') {
      const wrong = state.wrongs.find((item) => item.id === wrongId);
      if (wrong) wrong.mastered = data.correct;
    }

    updateProfileHeader();

    showFeedback(state.selected, data.correctAnswer, data.correct, data.explanation, data.pointsEarned || 0);

    if (mode === 'daily') updateDailyProgress();

    if (data.pointsEarned) toast(`答对了，+${data.pointsEarned} 积分`, 'success');
    else if (data.correct) toast('回答正确', 'success');
    else toast('答错了，已加入错题库', 'error');

    state.answering = false;
    updateActions();
  } catch (err) {
    state.answering = false;
    toast(err.message, 'error');
    updateSubmitState();
  }
}

function updateDailyProgress() {
  if (!state.daily) return;

  const answered = state.daily.questions.filter((question) => question.answered).length;
  state.daily.progress = { answered, total: state.daily.questions.length };
  $('#dailyProgress').textContent = `${answered}/${state.daily.questions.length}`;
}

function showFeedback(selected, correctAnswer, correct, explanation, pointsEarned) {
  const box = $('#feedbackArea');
  box.classList.remove('hidden');
  box.className = `feedback ${correct ? 'success' : 'error'}`;

  const selectedText = selected == null ? '--' : String.fromCharCode(65 + selected);
  const correctText = String.fromCharCode(65 + correctAnswer);

  box.innerHTML = `
    <div class="feedback-title">${correct ? ' 回答正确' : ' 回答错误'}</div>
    <div class="feedback-line">
      你的答案：<strong>${selectedText}</strong>
      ｜ 正确答案：<strong>${correctText}</strong>
      ${pointsEarned ? `｜ 获得 <strong>+${pointsEarned}</strong> 积分` : ''}
    </div>
    ${explanation ? `<div class="feedback-exp">${escapeHtml(explanation)}</div>` : ''}
  `;
}

function hideFeedback() {
  const box = $('#feedbackArea');
  box.classList.add('hidden');
  box.innerHTML = '';
}

function updateActions() {
  const current = state.current;
  const question = current?.question;
  const mode = current?.mode;

  if (!question) return;

  const answered = Boolean(question.answered);
  $('#submitBtn').classList.toggle('hidden', answered);

  if (!answered) {
    $('#nextBtn').classList.add('hidden');
    $('#extraBtn').classList.add('hidden');
    updateSubmitState();
    return;
  }

  if (mode === 'review') {
    $('#nextBtn').classList.remove('hidden');
    $('#nextBtn').textContent = '返回错题库';
    $('#extraBtn').classList.add('hidden');
    return;
  }

  if (mode === 'extra') {
    $('#nextBtn').classList.add('hidden');
    $('#extraBtn').classList.remove('hidden');
    updateExtraButton();
    return;
  }

  const hasNext = state.daily?.questions?.some((item) => !item.answered);
  $('#nextBtn').classList.remove('hidden');
  $('#nextBtn').textContent = hasNext ? '下一题' : '查看今日总结';
  $('#extraBtn').classList.remove('hidden');
  updateExtraButton();
}

function updateExtraButton() {
  const button = $('#extraBtn');
  const used = state.daily?.extraUsed || 0;
  const max = state.extraMax || EXTRA_MAX;

  button.textContent = used >= max ? '今日加题已达上限' : '再来一道';
  button.disabled = used >= max;
}

function nextQuestion() {
  if (state.current?.mode === 'review') {
    switchTab('wrong');
    loadWrongs();
    return;
  }

  const next = state.daily?.questions?.find((question) => !question.answered);

  if (next) renderQuestion(next, 'daily');
  else renderDailySummary();
}

function loadExtra() {
  if (state.answering) return;

  try {
    const data = getExtraQuestion();
    state.daily.extras ||= [];
    state.daily.extras.push(data.question);
    state.daily.extraUsed = data.extraUsed;
    renderQuestion(data.question, 'extra');
    toast('已加一道题', 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderDailySummary() {
  state.current = null;
  state.selected = null;

  const total = state.daily.questions.length;
  const correct = state.daily.questions.filter((question) => question.correct).length;
  const accuracy = total ? Math.round((correct / total) * 100) : 0;

  $('#questionText').innerHTML = `
    <span class="summary-emoji"></span>
    <strong>今日任务完成</strong><br />
    共 ${total} 题，答对 ${correct} 题，正确率 ${accuracy}%
  `;
  $('#options').innerHTML = '';
  $('#questionSource').textContent = '';
  $('#dailyProgress').textContent = `${total}/${total}`;

  hideFeedback();
  $('#submitBtn').classList.add('hidden');
  $('#nextBtn').classList.add('hidden');
  $('#extraBtn').classList.remove('hidden');
  updateExtraButton();
}

/* ------------------ 错题库 ------------------ */

function loadWrongs() {
  state.wrongs = state.user.wrongQuestions || [];
  renderWrongs();
}

function renderWrongs() {
  const container = $('#wrongList');
  container.innerHTML = '';

  if (!state.wrongs.length) {
    container.innerHTML = '<div class="empty">还没有错题，继续加油！</div>';
    return;
  }

  state.wrongs.forEach((wrong) => {
    const item = document.createElement('div');
    item.className = 'wrong-item';

    const options = wrong.options
      .map((option, index) => {
        const key = String.fromCharCode(65 + index);
        const correctClass = index === wrong.answerIndex ? 'correct' : '';
        return `<div class="wrong-option ${correctClass}">${key}. ${escapeHtml(option)}</div>`;
      })
      .join('');

    item.innerHTML = `
      <button class="wrong-head" type="button">
        <span class="wrong-question">${escapeHtml(wrong.question)}</span>
        <span class="wrong-meta">${wrong.mastered ? '已掌握' : '待复习'}  错${wrong.wrongCount || 1}次</span>
      </button>
      <div class="wrong-body hidden">
        <div class="wrong-options">${options}</div>
        ${wrong.explanation ? `<div class="wrong-exp">${escapeHtml(wrong.explanation)}</div>` : ''}
        <button class="secondary-btn review-btn" type="button">重做这题</button>
      </div>
    `;

    item.querySelector('.wrong-head').addEventListener('click', () => {
      item.querySelector('.wrong-body').classList.toggle('hidden');
    });

    item.querySelector('.review-btn').addEventListener('click', () => startReview(wrong));
    container.appendChild(item);
  });
}

function startReview(wrong) {
  switchTab('daily');

  const question = {
    id: wrong.questionId,
    question: wrong.question,
    options: wrong.options,
    source: wrong.source || '',
    sourceUrl: wrong.sourceUrl || '',
    answered: false
  };

  state.selected = null;
  renderQuestion(question, 'review', { wrongId: wrong.id });
}

/* ------------------ 我的 ------------------ */

function renderProfile() {
  const user = state.user;
  if (!user) return;

  const profile = publicProfile(user);
  const stats = profile.stats || {};

  $('#statsGrid').innerHTML = `
    <div class="stat"><span class="stat-value">${profile.points}</span><span class="stat-label">积分</span></div>
    <div class="stat"><span class="stat-value">${stats.answered || 0}</span><span class="stat-label">已答题</span></div>
    <div class="stat"><span class="stat-value">${stats.correct || 0}</span><span class="stat-label">答对</span></div>
    <div class="stat"><span class="stat-value">${stats.accuracy ?? 0}%</span><span class="stat-label">正确率</span></div>
    <div class="stat"><span class="stat-value">${stats.wrongPending ?? 0}</span><span class="stat-label">待复习错题</span></div>
    <div class="stat"><span class="stat-value">${profile.streak || 0}</span><span class="stat-label">连续签到</span></div>
  `;

  const bank = getBankStats();
  const status = $('#importStatus');
  if (status) {
    status.textContent = `内置 ${bank.builtin} 道 + 预置 ${bank.preloaded} 道 + 自定义 ${bank.imported} 道，当前可用 ${bank.playable} 道。`;
  }
}

/* ------------------ 导航 / 主题 / 事件 ------------------ */

function bindNav() {
  $$('#segTabs [data-tab], #bottomNav [data-tab]').forEach((button) => {
    button.addEventListener('click', () => switchTab(button.dataset.tab));
  });
}

function switchTab(tab) {
  state.tab = tab;

  $$('#segTabs [data-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });

  $$('#bottomNav [data-tab]').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tab);
  });

  $('#dailyTab').classList.toggle('hidden', tab !== 'daily');
  $('#wrongTab').classList.toggle('hidden', tab !== 'wrong');
  $('#profileTab').classList.toggle('hidden', tab !== 'profile');

  if (tab === 'wrong') loadWrongs();
  if (tab === 'profile') renderProfile();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initTheme() {
  const saved = localStorage.getItem('logic-theme');
  if (saved === 'dark') document.documentElement.classList.add('dark');
  updateThemeButton();
}

function toggleTheme() {
  document.documentElement.classList.toggle('dark');
  localStorage.setItem(
    'logic-theme',
    document.documentElement.classList.contains('dark') ? 'dark' : 'light'
  );
  updateThemeButton();
}

function updateThemeButton() {
  $('#themeBtn').textContent = document.documentElement.classList.contains('dark') ? '' : '';
}

function bindGameActions() {
  $('#submitBtn').addEventListener('click', submitAnswer);
  $('#nextBtn').addEventListener('click', nextQuestion);
  $('#extraBtn').addEventListener('click', loadExtra);
  $('#checkinBtn').addEventListener('click', handleCheckin);
  $('#checkinBtn2').addEventListener('click', handleCheckin);
  $('#themeBtn').addEventListener('click', toggleTheme);

  $('#logoutBtn').addEventListener('click', () => {
    localStorage.removeItem(STORAGE_SESSION);
    state.user = null;
    state.daily = null;
    state.wrongs = [];
    showAuth();
  });
}

/* ------------------ 小工具 ------------------ */

let toastTimer;

function toast(message, type = 'info') {
  const element = $('#toast');
  element.textContent = message;
  element.className = `toast show ${type}`;

  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    element.className = 'toast';
  }, 2600);
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => {
    const map = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    };
    return map[char];
  });
}