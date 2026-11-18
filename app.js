(() => {
  'use strict';

  /* ===== Конфигурация ===== */
  const DATA = window.ROUTE_DATA;
  const ROAD_ORDER = ['dry', 'high', 'night'];
  const ROAD_LABELS = { dry: 'Сухая', high: 'Высокая', night: 'Ночная' };
  const KEY = 'chantal.vertical-slice.v3';
  const NEUTRAL_ID = 'n02.neutral';

  function freshState() {
    return {
      schemaVersion: 3,
      day: 1,
      episode: 1,
      node: 1,
      choice: null,
      parentChoice: null,      // выбор узла 1, входит в узел 2
      lastChoice: null,        // выбор предыдущего узла (для условных патчей, например n03.share)
      consequence: null,       // текст последствия
      coins: DATA.meta.startCoins,
      relations: {...DATA.meta.startRelations },
      access: [],
      obligations: [],
      road: { dry: 0, high: 0, night: 0 },
      chantal: 'stay',         // 'stay' | 'away' | 'return'
      history: [],             // [{node, choiceId, patchId}]
      journal: [],             // journalFact записи
      finished: false
    };
  }

  /* ===== Доступ к данным ===== */
  const NODE_MAP = new Map(DATA.nodes.map(n => [n.nodeId, n]));

  function nodeDataById(nodeId) { return NODE_MAP.get(nodeId); }
  function choiceInNode(nodeId, choiceId) {
    const node = nodeDataById(nodeId);
    return node? node.choices.find(c => c.choiceId === choiceId): null;
  }

  /* ===== Валидация состояния ===== */
  function validState(value) {
    return value && value.schemaVersion === 3 &&
      Number.isInteger(value.day) && value.day >= 1 &&
      Number.isInteger(value.episode) && value.episode >= 1 &&
      Number.isInteger(value.node) && value.node >= 1 && value.node <= 12 &&
      (value.choice === null || typeof value.choice === 'string') &&
      (value.parentChoice === null || typeof value.parentChoice === 'string') &&
      (value.lastChoice === null || typeof value.lastChoice === 'string') &&
      Number.isInteger(value.coins) &&
      typeof value.relations === 'object' && value.relations!== null &&
      value.relations.host!== undefined &&
      Array.isArray(value.access) && Array.isArray(value.obligations) &&
      typeof value.road === 'object' && value.road!== null &&
      ['dry', 'high', 'night'].every(r => Number.isInteger(value.road[r])) &&
      ['stay', 'away', 'return'].includes(value.chantal) &&
      Array.isArray(value.history) && Array.isArray(value.journal) &&
      typeof value.finished === 'boolean';
  }

  /* ===== localStorage ===== */
  function loadState() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return freshState();
      const parsed = JSON.parse(raw);
      if (validState(parsed)) return parsed;
      localStorage.removeItem(KEY);
    } catch (error) {
      console.warn('Не удалось восстановить тестовое сохранение', error);
      try { localStorage.removeItem(KEY); } catch (_) { /* storage недоступен */ }
    }
    return freshState();
  }
  function saveState() {
    try {
      localStorage.setItem(KEY, JSON.stringify(state));
      return true;
    } catch (error) {
      console.error('Не удалось сохранить тестовое состояние', error);
      return false;
    }
  }

  let state = loadState();
  const app = document.querySelector('#app');
  let fallbackVisible = false;
  let neutralMode = false;   // тест-маршрут: добавить кнопку нейтралитета в узел 2
  let storageWarning = false;

  /* ===== Применение патча ===== */
  function applyPatch(patch) {
    // ресурсы
    const coins = state.coins + (patch.resourceDelta?.coins?? 0);
    state.coins = Math.max(0, coins);

    // отношения: прямые + условные
    const nextRelations = {...state.relations };
    for (const key of ['host', 'caravan', 'woman', 'creatures']) {
      nextRelations[key] += patch.relationshipDelta?.[key]?? 0;
    }
    const cond = patch.relationshipConditional;
    if (cond) {
      let target = null;
      // условный выбор: смотрим на выбор ПРЕДЫДУЩЕГО узла (state.lastChoice), а не входного узла 1 (parentChoice)
      if (cond.onPreviousChoice && state.lastChoice && cond.onPreviousChoice[state.lastChoice]) {
        target = cond.onPreviousChoice[state.lastChoice];
      } else if (cond.onAccess) {
        const hasAny = cond.onAccess.some(tag => state.access.includes(tag));
        target = hasAny? cond.target: cond.fallback;
      } else if (cond.default) {
        target = cond.default;
      }
      if (target && nextRelations[target]!== undefined) {
        nextRelations[target] += cond.amount?? 1;
      }
    }
    state.relations = nextRelations;

    // доступ
    const access = new Set(state.access);
    for (const tag of patch.accessDelta?.granted?? []) access.add(tag);
    for (const tag of patch.accessDelta?.revoked?? []) access.delete(tag);
    state.access = [...access];

    // обязательства
    const obligations = new Set(state.obligations);
    for (const item of patch.obligationDelta?.add?? []) obligations.add(item);
    for (const item of patch.obligationDelta?.remove?? []) obligations.delete(item);
    state.obligations = [...obligations];

    // дороги
    const road = {...state.road };
    for (const key of ROAD_ORDER) road[key] += patch.roadDelta?.[key]?? 0;
    state.road = road;

    // Шанталь
    switch (patch.chantalPresenceDelta) {
      case 'away': state.chantal = 'away'; break;
      case 'return': state.chantal = 'return'; break;
      default: break; // stay - без изменений
    }

    // хроника
    if (patch.journalFact) state.journal.push(patch.journalFact);
  }

  /* ===== Доступность выбора (узел 11) ===== */
  function isChoiceAvailable(choice, access, obligations, relations, road) {
    const rules = choice.available?.rules;
    if (!rules || rules.length === 0) return true;
    const satisfied = rules.some(rule => {
      if (rule.road) return road[rule.road] >= (rule.min?? 1);
      if (rule.relation) return (relations[rule.relation]?? 0) >= (rule.min?? 1);
      if (rule.obligationsAny) return obligations.length > 0;
      if (rule.access) return rule.access.some(tag => access.includes(tag));
      return false;
    });
    return choice.available.type === 'any'? satisfied: satisfied;
  }

  function availableChoiceIds(nodeId) {
    const node = nodeDataById(nodeId);
    if (!node) return [];
    if (state.finished) return [];
    if (nodeId === 2 &&!neutralMode) {
      // узлы 1-10: все кнопки, кроме нейтралитета (он - тест-маршрут)
      return node.choices.filter(c => c.choiceId!== NEUTRAL_ID).map(c => c.choiceId);
    }
    if (nodeId === 11) {
      return node.choices
.filter(c => isChoiceAvailable(c, state.access, state.obligations, state.relations, state.road))
.map(c => c.choiceId);
    }
    return node.choices.map(c => c.choiceId);
  }

  /* ===== Рендер ===== */
  function render() {
    const statusLine = `
      <div class="status">
        <span>Глава 1</span><span>День ${state.day}</span><span>Эпизод ${state.episode}</span>
        <span>Гроши: ${state.coins}</span><span>Шанталь: ${state.chantal}</span>
        <span>Дороги: С ${state.road.dry} / В ${state.road.high} / Н ${state.road.night}</span>
      </div>`;

    let body;
    if (state.finished) {
      body = finalCard();
    } else if (fallbackVisible) {
      body = fallbackCard();
    } else if (journalVisible) {
      body = journalCard();
    } else if (state.choice && state.consequence) {
      body = consequenceCard();
    } else {
      body = sceneCard();
    }

    app.innerHTML = `
      <div class="eyebrow">Chantal / полный маршрут главы 1</div>
      <section class="card">
        <h1>Три дороги и один свободный стол</h1>
        ${statusLine}
      </section>
      ${body}
      <section class="card">
        <div class="actions">
          <button type="button" data-action="reset">Сбросить тест</button>
          <button type="button" data-action="fallback">Проверить offline fallback</button>
          ${!state.finished && state.node === 2 &&!neutralMode? '<button type="button" data-action="neutral">Тест: нейтральный маршрут</button>': ''}
          ${state.journal.length? '<button type="button" data-action="journal">Хроника</button>': ''}
        </div>
        <p class="muted">Патчи применяются по схеме chapter1-patches.json. Генерация модели не подключена.</p>
      </section>`;

    app.querySelectorAll('[data-choice]').forEach(btn => {
      btn.addEventListener('click', () => choose(btn.dataset.choice));
    });
    const reset = app.querySelector('[data-action="reset"]');
    if (reset) reset.addEventListener('click', resetState);
    const fb = app.querySelector('[data-action="fallback"]');
    if (fb) fb.addEventListener('click', showFallback);
    const neutral = app.querySelector('[data-action="neutral"]');
    if (neutral) neutral.addEventListener('click', enableNeutral);
    const journalBtn = app.querySelector('[data-action="journal"]');
    if (journalBtn) journalBtn.addEventListener('click', toggleJournal);
    const retry = app.querySelector('[data-action="retry"]');
    if (retry) retry.addEventListener('click', () => { fallbackVisible = false; render(); });
    const jc = app.querySelector('[data-action="journal-close"]');
    if (jc) jc.addEventListener('click', () => { journalVisible = false; render(); });
    const proceed = app.querySelector('[data-action="continue"]');
    if (proceed) proceed.addEventListener('click', nextNode);

    if (storageWarning) {
      const warning = document.createElement('p');
      warning.className = 'notice';
      warning.textContent = 'Браузер не сохранил состояние. Продолжайте только в этой вкладке или включите локальное хранилище.';
      app.prepend(warning);
      storageWarning = false;
    }
  }

  function sceneCard() {
    if (state.node >= 1 && state.node <= 12) {
      const node = nodeDataById(state.node);
      if (!node) return `<section class="card"><h2>Узел ${state.node} не найден</h2></section>`;
      const available = availableChoiceIds(state.node);
      let help = '';
      if (state.node === 1) {
        help = '<p class="notice">Входной узел: сначала осмотреться или потребовать объяснения. Выбор попадёт в узел 2 как parentChoiceId.</p>';
      } else if (state.node === 2) {
        help = '<p class="notice">Четыре варианта узла 2. Нейтральное поведение доступно как тест-маршрут кнопкой ниже.</p>';
      } else if (state.node === 11) {
        help = '<p class="notice">Дороги открываются по накопленным следам. Недоступные скрыты, но выход существует всегда.</p>';
      }
      const buttons = available.map(id => {
        const c = choiceInNode(state.node, id);
        return `<button type="button" data-choice="${id}">${c.label}</button>`;
      }).join('');
      return `<section class="card"><h2>Узел ${String(state.node).padStart(2, '0')}. ${node.title}</h2><p>${node.scene}</p>${help}${buttons}</section>`;
    }
    return `<section class="card"><h2>Неизвестный узел</h2></section>`;
  }

  function consequenceCard() {
    const node = nodeDataById(state.node);
    const label = node? node.title: '';
    const chantalNote = state.node === 12
? '<p class="notice">Шанталь молчит, но это уже ответ.</p>'
: '<p class="notice">Шанталь наблюдает. Это тоже её оценка.</p>';
    const continueBtn = state.node < 12
? '<button type="button" data-action="continue">Продолжить</button>'
: '<button type="button" data-action="continue">Завершить главу</button>';
    return `<section class="card"><h2>Узел ${String(state.node).padStart(2, '0')}. ${label}</h2><p>${state.consequence}</p>${chantalNote}${continueBtn}</section>`;
  }

  function finalCard() {
    const bestRoad = ROAD_ORDER.reduce((best, r) => state.road[r] > state.road[best]? r: best, ROAD_ORDER[0]);
    const relations = Object.entries(state.relations)
.map(([k, v]) => `${k}: ${v > 0? '+': ''}${v}`).join(' · ');
    return `
      <section class="card">
        <h2>Глава завершена. Выход из города.</h2>
        <p>Дорога: <strong>${ROAD_LABELS[bestRoad]}</strong> (${state.road[bestRoad]}).</p>
        <p class="small">Гроши: ${state.coins} · Отношения: ${relations}</p>
        <p class="small">Доступ: ${state.access.join(', ') || 'нет'} · Обязательства: ${state.obligations.join(', ') || 'нет'}</p>
        <p class="muted">Шанталь ${state.chantal === 'away'? 'отлучалась': state.chantal === 'return'? 'вернулась и оглянулась на город': 'осталась рядом'}.</p>
      </section>`;
  }

  function fallbackCard() {
    return `<section class="card notice"><h2>Дорога не в порядке</h2><p>Сейчас не удаётся продолжить сцену. Сохранённые факты не изменены.</p><button type="button" data-action="retry">Повторить позже</button><p class="muted">В полном приложении можно продолжить валидный сохранённый узел или завершить день без отдельного штрафа.</p></section>`;
  }

  /* ===== Действия ===== */
  function choose(choiceId) {
    if (state.finished || state.choice) return;
    const node = nodeDataById(state.node);
    const choice = choiceInNode(state.node, choiceId);
    if (!node ||!choice) return;
    const available = availableChoiceIds(state.node);
    if (!available.includes(choiceId)) return;

    if (state.node === 1) {
      // входной узел: выбор записывается как parentChoice и ведёт в узел 2
      applyPatch(choice.patch);
      state = {
...state,
        parentChoice: choiceId,
        lastChoice: choiceId,
        history: [...state.history, { node: 1, choiceId, patchId: choice.patch.patchId }]
      };
      state.consequence = choice.result;
      state.choice = choiceId;
      save();
      render();
      return;
    }

    if (state.node === 12) {
      applyPatch(choice.patch);
      state.history.push({ node: 12, choiceId, patchId: choice.patch.patchId });
      state.consequence = choice.result;
      state.choice = choiceId;
      state.lastChoice = choiceId;
      save();
      render();
      return;
    }

    // узлы 2-11: применять патч сразу (последствие показано после)
    applyPatch(choice.patch);
    state.history.push({ node: state.node, choiceId, patchId: choice.patch.patchId });
    state.choice = choiceId;
    state.consequence = choice.result;
    state.lastChoice = choiceId;
    save();
    render();
  }

  function nextNode() {
    if (!state.choice || state.finished) return;
    const choice = choiceInNode(state.node, state.choice);
    const next = choice? choice.nextNode: null;
    if (next === null || next === undefined) {
      // узел 12: конец главы
      state.finished = true;
      state.choice = null;
      save();
      render();
      return;
    }
    state = {
...state,
      node: next,
      choice: null,
      consequence: null
    };
    // при переходе в узел 2 parentChoice уже установлен; при переходе в другие узлы - остаётся как есть
    save();
    render();
  }

  function enableNeutral() {
    if (state.node!== 2 || state.choice) return;
    neutralMode = true;
    render();
  }

  let journalVisible = false;

  function toggleJournal() {
    journalVisible =!journalVisible;
    render();
  }

  function journalCard() {
    return `<section class="card"><h3>Хроника вечера</h3>${state.journal.map(j => `<p class="muted">· ${j}</p>`).join('') || '<p class="muted">Пока пусто.</p>'}<button type="button" data-action="journal-close">Скрыть хронику</button></section>`;
  }

  function showFallback() {
    fallbackVisible = true;
    render();
  }

  function resetState() {
    try { localStorage.removeItem(KEY); } catch (error) { console.warn('Не удалось очистить тестовое сохранение', error); }
    state = freshState();
    neutralMode = false;
    storageWarning = false;
    fallbackVisible = false;
    render();
  }

  function save() {
    if (!saveState()) storageWarning = true;
    else storageWarning = false;
  }

  render();
})();