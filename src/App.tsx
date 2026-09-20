import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, ClipboardCheck, History, Mic, Pause, Play, Plus, RotateCcw, Search, Trash2, Volume2 } from 'lucide-react';

// ---------- 类型 ----------
type PhraseStatus = 'new' | 'practice' | 'review' | 'mastered';
type Phrase = { id: number; text: string; translation: string; tag: string; level: '入门' | '进阶' | '挑战'; status: PhraseStatus; attempts: number; last?: string };
type Deduction = { item: string; points: number };
type RecordingVersion = {
  id: string; phraseId: number; version: number; createdAt: string;
  source: 'recording' | 'review';
  machineScore: number | null; reviewerScore: number | null; finalScore: number | null;
  gap: number | null; deductions: Deduction[]; durationSec: number;
  note?: string; basedOn?: number;
};
type ReviewTicket = {
  id: string; phraseId: number; versionId: string; version: number;
  machineScore: number; reviewerScore: number; gap: number; deductions: Deduction[];
  status: 'pending' | 'resolved'; createdAt: string; resolvedAt?: string;
  resolution?: 'confirm-machine' | 'confirm-reviewer' | 'adjust';
  finalScore?: number; reason?: string; newVersion?: number;
};
type ConflictEntry = { id: string; time: string; phraseId: number; phraseText: string; oldScore: string; newScore: string; rule: string };

// ---------- 复核规则常量 ----------
const MASTER_LINE = 85; // 掌握线：最终分达到即标为已掌握
const GAP_LIMIT = 8;    // 机器分与评审分分差超过该值强制进入待复核

const STATUS_LABEL: Record<PhraseStatus, string> = { new: '未练习', practice: '练习中', review: '待复核', mastered: '已掌握' };
const DEDUCTION_POOL = ['连读不自然', '重音位置偏差', '语速过快', '尾音吞音', '元音饱满度不足', '语调平淡'];

// ---------- 种子数据（一句正处于待复核，便于演示完整链路） ----------
const seedPhrases: Phrase[] = [
  { id: 1, text: 'The morning light feels different today.', translation: '今天的晨光感觉不一样。', tag: '日常', level: '入门', status: 'review', attempts: 3, last: '今天 09:24' },
  { id: 2, text: 'Could you walk me through the next step?', translation: '你能带我了解下一步吗？', tag: '工作', level: '进阶', status: 'new', attempts: 0 },
  { id: 3, text: 'I appreciate your patience and thoughtful feedback.', translation: '感谢你的耐心和细致反馈。', tag: '表达', level: '挑战', status: 'mastered', attempts: 8, last: '昨天 18:10' },
  { id: 4, text: 'Let’s make room for a little curiosity.', translation: '给好奇心留一点空间。', tag: '灵感', level: '入门', status: 'new', attempts: 0 },
];
const seedVersions: Record<number, RecordingVersion[]> = {
  1: [
    { id: 'seed-v1', phraseId: 1, version: 1, createdAt: '昨天 20:12', source: 'recording', machineScore: 74, reviewerScore: 79, finalScore: 74, gap: 5, durationSec: 11, deductions: [{ item: '连读不自然', points: 9 }, { item: '尾音吞音', points: 6 }, { item: '语速过快', points: 6 }, { item: '语调平淡', points: 5 }] },
    { id: 'seed-v2', phraseId: 1, version: 2, createdAt: '今天 09:24', source: 'recording', machineScore: 78, reviewerScore: 91, finalScore: null, gap: 13, durationSec: 9, deductions: [{ item: '元音饱满度不足', points: 8 }, { item: '连读不自然', points: 7 }, { item: '重音位置偏差', points: 7 }] },
  ],
  3: [
    { id: 'seed-v3', phraseId: 3, version: 1, createdAt: '昨天 18:10', source: 'recording', machineScore: 86, reviewerScore: 88, finalScore: 86, gap: 2, durationSec: 12, deductions: [{ item: '语速过快', points: 5 }, { item: '尾音吞音', points: 5 }, { item: '语调平淡', points: 4 }] },
  ],
};
const seedTickets: ReviewTicket[] = [
  { id: 'seed-t1', phraseId: 1, versionId: 'seed-v2', version: 2, machineScore: 78, reviewerScore: 91, gap: 13, status: 'pending', createdAt: '今天 09:24', deductions: [{ item: '元音饱满度不足', points: 8 }, { item: '连读不自然', points: 7 }, { item: '重音位置偏差', points: 7 }] },
];

const bars = Array.from({ length: 68 }, (_, i) => 18 + ((i * 29) % 44));
const uid = () => Math.random().toString(36).slice(2, 10);
const stamp = () => { const d = new Date(); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`; };
const pair = (m: number, r: number) => `机器 ${m} / 评审 ${r}`;

function makeDeductions(total: number): Deduction[] {
  if (total <= 0) return [];
  const count = Math.min(DEDUCTION_POOL.length, Math.max(1, Math.ceil(total / 7)));
  const items = [...DEDUCTION_POOL].sort(() => Math.random() - 0.5).slice(0, count);
  const out: Deduction[] = [];
  let left = total;
  items.forEach((item, i) => {
    const pts = i === items.length - 1 ? left : Math.max(1, Math.min(9, Math.round(left / (items.length - i))));
    if (pts > 0 && left > 0) { out.push({ item, points: pts }); left -= pts; }
  });
  return out;
}

function readStorage<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) as T : fallback; } catch { return fallback; }
}

// 启动时校正持久化数据，保证刷新后待办、版本、状态三者一致
function reconcile(phrases: Phrase[], tickets: ReviewTicket[]): { phrases: Phrase[]; tickets: ReviewTicket[]; conflicts: ConflictEntry[] } {
  const conflicts: ConflictEntry[] = [];
  const phraseIds = new Set(phrases.map(p => p.id));
  let fixed = tickets.filter(t => phraseIds.has(t.phraseId)).map(t => ({ ...t }));
  // 规则：同一句只能有一张待复核单 —— 保留最早一张，其余合并
  const pendingByPhrase = new Map<number, ReviewTicket[]>();
  fixed.filter(t => t.status === 'pending').forEach(t => pendingByPhrase.set(t.phraseId, [...(pendingByPhrase.get(t.phraseId) ?? []), t]));
  pendingByPhrase.forEach((list, phraseId) => {
    if (list.length < 2) return;
    const keeper = list[0];
    list.slice(1).forEach(extra => {
      conflicts.push({ id: uid(), time: stamp(), phraseId, phraseText: phrases.find(p => p.id === phraseId)?.text ?? `#${phraseId}`, oldScore: pair(extra.machineScore, extra.reviewerScore), newScore: pair(keeper.machineScore, keeper.reviewerScore), rule: '同一句只能有一张待复核单（重复复核单已合并）' });
      fixed = fixed.map(t => t.id === extra.id ? { ...t, status: 'resolved' as const, resolution: 'confirm-machine' as const, finalScore: keeper.machineScore, reason: `与复核单 ${keeper.id.slice(0, 6)} 重复，系统自动合并`, resolvedAt: stamp() } : t);
    });
  });
  const pendingIds = new Set(fixed.filter(t => t.status === 'pending').map(t => t.phraseId));
  const fixedPhrases = phrases.map(p => {
    // 规则：复核结束前不得标为已掌握 —— 已掌握但仍有待复核单的回退为待复核
    if (p.status === 'mastered' && pendingIds.has(p.id)) {
      const t = fixed.find(t => t.phraseId === p.id && t.status === 'pending')!;
      conflicts.push({ id: uid(), time: stamp(), phraseId: p.id, phraseText: p.text, oldScore: pair(t.machineScore, t.reviewerScore), newScore: '已回退为待复核', rule: '复核结束前不得标为已掌握（状态已校正）' });
      return { ...p, status: 'review' as PhraseStatus };
    }
    // 待复核状态必须存在进行中的复核单，否则按最近复核结果回落
    if (p.status === 'review' && !pendingIds.has(p.id)) {
      const resolved = [...fixed].reverse().find(t => t.phraseId === p.id && t.status === 'resolved' && t.finalScore != null);
      const status: PhraseStatus = resolved ? (resolved.finalScore! >= MASTER_LINE ? 'mastered' : 'practice') : 'practice';
      conflicts.push({ id: uid(), time: stamp(), phraseId: p.id, phraseText: p.text, oldScore: '状态：待复核（无复核单）', newScore: resolved ? `复核分 ${resolved.finalScore}` : '无复核记录', rule: '待复核状态必须有进行中的复核单（已按复核结果校正）' });
      return { ...p, status };
    }
    return p;
  });
  return { phrases: fixedPhrases, tickets: fixed, conflicts };
}

function loadBoot() {
  const rawPhrases = readStorage<Phrase[]>('sound-lab-phrases', seedPhrases);
  const rawTickets = readStorage<ReviewTicket[]>('sound-lab-tickets', seedTickets);
  const versions = readStorage<Record<number, RecordingVersion[]>>('sound-lab-versions', seedVersions);
  const storedConflicts = readStorage<ConflictEntry[]>('sound-lab-conflicts', []);
  const { phrases, tickets, conflicts } = reconcile(rawPhrases, rawTickets);
  return { phrases, versions, tickets, conflicts: [...conflicts, ...storedConflicts].slice(0, 50), fresh: conflicts };
}

// ---------- 复核单卡片 ----------
function TicketCard({ ticket, phrase, onResolve }: { ticket: ReviewTicket; phrase?: Phrase; onResolve: (t: ReviewTicket, resolution: 'confirm-machine' | 'confirm-reviewer' | 'adjust', finalScore: number, reason?: string) => void }) {
  const [mode, setMode] = useState<'confirm' | 'adjust'>('confirm');
  const [score, setScore] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const submitAdjust = () => {
    const s = Number(score);
    if (!score.trim() || Number.isNaN(s) || s < 0 || s > 100) { setError('请输入 0–100 之间的调整分'); return; }
    if (!reason.trim()) { setError('调整分数必须填写依据'); return; }
    onResolve(ticket, 'adjust', Math.round(s), reason.trim());
  };
  return <div className="ticket">
    <div className="ticket-head">
      <div><strong>{phrase?.text ?? `句子 #${ticket.phraseId}`}</strong><span>{phrase?.translation ?? ''}</span></div>
      <span className="gap-badge">分差 {ticket.gap}</span>
    </div>
    <div className="ticket-scores">
      <div><span>机器分</span><b>{ticket.machineScore}</b></div>
      <div><span>评审分</span><b>{ticket.reviewerScore}</b></div>
      <div><span>录音版本</span><b>v{ticket.version}</b></div>
      <div><span>提交时间</span><b>{ticket.createdAt}</b></div>
    </div>
    {ticket.deductions.length > 0 && <div className="deductions"><span className="deductions-label">扣分项</span>{ticket.deductions.map(d => <span key={d.item} className="deduction-chip">{d.item} −{d.points}</span>)}</div>}
    <div className="segmented">
      <button className={mode === 'confirm' ? 'active' : ''} onClick={() => setMode('confirm')}>确认原分</button>
      <button className={mode === 'adjust' ? 'active' : ''} onClick={() => setMode('adjust')}>调整分数</button>
    </div>
    {mode === 'confirm'
      ? <div className="ticket-actions">
          <button className="secondary" onClick={() => onResolve(ticket, 'confirm-machine', ticket.machineScore)}>确认机器分 {ticket.machineScore}</button>
          <button className="secondary" onClick={() => onResolve(ticket, 'confirm-reviewer', ticket.reviewerScore)}>确认评审分 {ticket.reviewerScore}</button>
        </div>
      : <div className="adjust-form">
          <div className="adjust-row">
            <input value={score} onChange={e => setScore(e.target.value)} placeholder="调整分（0–100）" inputMode="numeric" />
            <button className="primary" onClick={submitAdjust}>提交复核</button>
          </div>
          <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="调整依据（必填）：例如机器漏判连读、评审听感更贴近实际发音……" />
          {error && <p className="form-error">{error}</p>}
        </div>}
    <p className="ticket-rule">规则：分差 &gt; {GAP_LIMIT} 分强制复核 · 复核结果 ≥ {MASTER_LINE} 分标为已掌握，低于掌握线回到练习中 · 调整分将生成带原因的新版本</p>
  </div>;
}

export default function App() {
  const [boot] = useState(loadBoot);
  const [phrases, setPhrases] = useState<Phrase[]>(boot.phrases);
  const [versions, setVersions] = useState<Record<number, RecordingVersion[]>>(boot.versions);
  const [tickets, setTickets] = useState<ReviewTicket[]>(boot.tickets);
  const [conflicts, setConflicts] = useState<ConflictEntry[]>(boot.conflicts);
  const [conflictModal, setConflictModal] = useState<ConflictEntry[] | null>(boot.fresh.length ? boot.fresh : null);
  const [view, setView] = useState<'library' | 'reviews'>('library');
  const [selected, setSelected] = useState(phrases[0]?.id ?? 1);
  const [filter, setFilter] = useState('全部');
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [recorded, setRecorded] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [newText, setNewText] = useState('');
  const timer = useRef<number | undefined>(undefined);

  const current = phrases.find(p => p.id === selected) ?? phrases[0];
  const currentId = current?.id ?? 0;
  const currentVersions = versions[currentId] ?? [];
  const latestVersion = currentVersions[currentVersions.length - 1];
  const currentPending = tickets.find(t => t.phraseId === currentId && t.status === 'pending');
  const pendingTickets = tickets.filter(t => t.status === 'pending');
  const resolvedTickets = tickets.filter(t => t.status === 'resolved');
  const confirmCount = resolvedTickets.filter(t => t.resolution !== 'adjust').length;
  const adjustCount = resolvedTickets.filter(t => t.resolution === 'adjust').length;
  const today = useMemo(() => new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }).toUpperCase(), []);
  const filtered = useMemo(() => phrases.filter(p => (filter === '全部' || p.tag === filter || p.level === filter || (filter === '待练' && p.status !== 'mastered') || (filter === '已掌握' && p.status === 'mastered') || (filter === '待复核' && p.status === 'review')) && p.text.toLowerCase().includes(query.toLowerCase())), [phrases, filter, query]);
  const tags = ['全部', ...Array.from(new Set(phrases.map(p => p.tag)))];

  useEffect(() => { localStorage.setItem('sound-lab-phrases', JSON.stringify(phrases)); }, [phrases]);
  useEffect(() => { localStorage.setItem('sound-lab-versions', JSON.stringify(versions)); }, [versions]);
  useEffect(() => { localStorage.setItem('sound-lab-tickets', JSON.stringify(tickets)); }, [tickets]);
  useEffect(() => { localStorage.setItem('sound-lab-conflicts', JSON.stringify(conflicts)); }, [conflicts]);
  useEffect(() => () => window.clearInterval(timer.current), []);

  const pushConflicts = (entries: ConflictEntry[]) => { setConflicts(cs => [...entries, ...cs].slice(0, 50)); setConflictModal(entries); };

  // 结束录音：保存机器分、评审分、录音版本与扣分项；分差 > 8 只能进入待复核
  const finishRecording = () => {
    window.clearInterval(timer.current);
    setRecording(false);
    setRecorded(true);
    if (!current) return;
    const machineScore = 62 + Math.floor(Math.random() * 37);
    const reviewerScore = Math.min(100, Math.max(35, machineScore + Math.round((Math.random() * 2 - 1) * 14)));
    const gap = Math.abs(machineScore - reviewerScore);
    const deductions = makeDeductions(100 - machineScore);
    const disputed = gap > GAP_LIMIT;
    const versionNo = currentVersions.length + 1;
    const v: RecordingVersion = { id: uid(), phraseId: currentId, version: versionNo, createdAt: stamp(), source: 'recording', machineScore, reviewerScore, finalScore: disputed ? null : machineScore, gap, deductions, durationSec: Math.max(seconds, 1) };
    setVersions(vs => ({ ...vs, [currentId]: [...(vs[currentId] ?? []), v] }));
    let nextStatus: PhraseStatus;
    if (disputed) {
      nextStatus = 'review';
      const existing = tickets.find(t => t.phraseId === currentId && t.status === 'pending');
      if (existing) {
        pushConflicts([{ id: uid(), time: stamp(), phraseId: currentId, phraseText: current.text, oldScore: pair(existing.machineScore, existing.reviewerScore), newScore: pair(machineScore, reviewerScore), rule: `同一句只能有一张待复核单（新分歧 ${gap} 分 > ${GAP_LIMIT} 分，未重复立案）` }]);
      } else {
        setTickets(ts => [{ id: uid(), phraseId: currentId, versionId: v.id, version: versionNo, machineScore, reviewerScore, gap, deductions, status: 'pending', createdAt: stamp() }, ...ts]);
      }
    } else {
      nextStatus = machineScore >= MASTER_LINE ? 'mastered' : 'practice';
    }
    setPhrases(ps => ps.map(p => p.id === currentId ? { ...p, attempts: p.attempts + 1, status: nextStatus, last: '刚刚' } : p));
  };
  const toggleRecord = () => { if (recording) { finishRecording(); return; } setSeconds(0); setRecording(true); timer.current = window.setInterval(() => setSeconds(s => s + 1), 1000); };

  // 复核结案：确认原分落定争议版本；调整分生成带原因的新版本，旧录音旧分保留可查
  const resolveTicket = (ticket: ReviewTicket, resolution: 'confirm-machine' | 'confirm-reviewer' | 'adjust', finalScore: number, reason?: string) => {
    let newVersion: number | undefined;
    if (resolution === 'adjust') {
      newVersion = (versions[ticket.phraseId]?.length ?? 0) + 1;
      const nv: RecordingVersion = { id: uid(), phraseId: ticket.phraseId, version: newVersion, createdAt: stamp(), source: 'review', machineScore: null, reviewerScore: null, finalScore, gap: null, deductions: [], durationSec: 0, note: reason, basedOn: ticket.version };
      setVersions(vs => ({ ...vs, [ticket.phraseId]: [...(vs[ticket.phraseId] ?? []), nv] }));
    } else {
      setVersions(vs => ({ ...vs, [ticket.phraseId]: (vs[ticket.phraseId] ?? []).map(v => v.id === ticket.versionId ? { ...v, finalScore } : v) }));
    }
    setTickets(ts => ts.map(t => t.id === ticket.id ? { ...t, status: 'resolved', resolution, finalScore, reason, newVersion, resolvedAt: stamp() } : t));
    setPhrases(ps => ps.map(p => p.id === ticket.phraseId ? { ...p, status: finalScore >= MASTER_LINE ? 'mastered' : 'practice', last: '刚刚' } : p));
  };

  // 手动标已掌握：复核未结束时触发冲突拦截
  const markMastered = () => {
    if (!current) return;
    if (currentPending) {
      pushConflicts([{ id: uid(), time: stamp(), phraseId: currentId, phraseText: current.text, oldScore: pair(currentPending.machineScore, currentPending.reviewerScore), newScore: '维持待复核', rule: `分差 ${currentPending.gap} 分 > ${GAP_LIMIT} 分，复核结束前不得标为已掌握` }]);
      return;
    }
    setPhrases(ps => ps.map(p => p.id === currentId ? { ...p, status: 'mastered' } : p));
  };

  const addPhrase = () => { if (!newText.trim()) return; const id = Date.now(); setPhrases(ps => [...ps, { id, text: newText.trim(), translation: '待补充译文', tag: '自定义', level: '入门', status: 'new', attempts: 0 }]); setSelected(id); setNewText(''); setShowAdd(false); };
  const removePhrase = () => {
    if (!current) return;
    const id = currentId;
    setPhrases(ps => ps.filter(p => p.id !== id));
    setVersions(vs => { const n = { ...vs }; delete n[id]; return n; });
    setTickets(ts => ts.filter(t => t.phraseId !== id));
    setSelected(filtered.find(p => p.id !== id)?.id ?? phrases.find(p => p.id !== id)?.id ?? 0);
  };
  const selectPhrase = (id: number) => { if (recording) { window.clearInterval(timer.current); setRecording(false); } setSelected(id); setRecorded(false); setSeconds(0); };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Volume2 size={19}/></div><div><strong>声线练习室</strong><span>Pronounce / practice</span></div></div>
      <div className="side-label">我的练习</div>
      <nav>
        <button className={view === 'library' && filter !== '已掌握' ? 'side-link active' : 'side-link'} onClick={() => { setView('library'); setFilter('全部'); }}><Mic size={17}/>练习库 <b>{phrases.length}</b></button>
        <button className={view === 'reviews' ? 'side-link active' : 'side-link'} onClick={() => setView('reviews')}><ClipboardCheck size={17}/>复核中心 {pendingTickets.length > 0 && <i className="nav-dot">{pendingTickets.length}</i>}</button>
        <button className={view === 'library' && filter === '已掌握' ? 'side-link active' : 'side-link'} onClick={() => { setView('library'); setFilter('已掌握'); }}><Check size={17}/>已掌握 <b>{phrases.filter(p => p.status === 'mastered').length}</b></button>
      </nav>
      <div className="sidebar-foot"><div className="streak"><span>连续练习</span><strong>5 <small>天</small></strong><i>↗ +2</i></div><div className="profile"><div className="avatar">YL</div><div><strong>Yuki Lin</strong><span>普通计划</span></div><ChevronRight size={16}/></div></div>
    </aside>
    <main className="main">
      <header className="topbar">
        <div><p className="eyebrow">{view === 'library' ? today : 'REVIEW CENTER'}</p><h1>{view === 'library' ? '今天练什么？' : '评分复核中心'}</h1></div>
        <div className="top-actions">
          {view === 'library' && <><div className="search"><Search size={16}/><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索句子"/></div><button className="primary" onClick={() => setShowAdd(true)}><Plus size={17}/>添加句子</button></>}
          {view === 'reviews' && <span className="topbar-hint">掌握线 {MASTER_LINE} 分 · 分差阈值 {GAP_LIMIT} 分</span>}
        </div>
      </header>

      {view === 'reviews' ? <>
        <section className="stats">
          <div><span>待复核</span><strong>{pendingTickets.length} <em>单</em></strong><div className="progress"><i style={{ width: `${Math.min(100, pendingTickets.length * 25)}%` }}/></div></div>
          <div><span>已复核</span><strong>{resolvedTickets.length} <em>单</em></strong><small>确认原分 {confirmCount} · 调整分 {adjustCount}</small></div>
          <div><span>冲突记录</span><strong>{conflicts.length} <em>条</em></strong><small className={conflicts.length ? 'amber' : 'green'}>{conflicts.length ? '存在被规则拦截的操作' : '暂无冲突'}</small></div>
        </section>
        <div className="review-board">
          <section className="review-col">
            <div className="section-head"><div><h2>待复核 <span className="count-pill">{pendingTickets.length}</span></h2><p>机器分与评审分分差超过 {GAP_LIMIT} 分，复核完成前不得标为已掌握</p></div></div>
            <div className="ticket-list">
              {pendingTickets.map(t => <TicketCard key={t.id} ticket={t} phrase={phrases.find(p => p.id === t.phraseId)} onResolve={resolveTicket}/>)}
              {pendingTickets.length === 0 && <div className="empty">没有待复核的评分争议</div>}
            </div>
          </section>
          <section className="review-col">
            <div className="section-head"><div><h2>复核记录</h2><p>确认原分与调整分的历史，旧录音旧分均可回查</p></div></div>
            {resolvedTickets.map(t => {
              const phrase = phrases.find(p => p.id === t.phraseId);
              return <div className="history-item" key={t.id}>
                <div className="history-main">
                  <strong>{phrase?.text ?? `句子 #${t.phraseId}`}</strong>
                  <span>{t.resolution === 'adjust' ? `调整分 ${t.finalScore} · 生成新版本 v${t.newVersion}` : t.resolution === 'confirm-reviewer' ? `确认评审分 ${t.finalScore}` : `确认机器分 ${t.finalScore}`}（原 {pair(t.machineScore, t.reviewerScore)}）</span>
                  {t.reason && <em>依据：{t.reason}</em>}
                </div>
                <div className="history-side">
                  <b className={t.finalScore != null && t.finalScore >= MASTER_LINE ? 'green' : 'amber'}>{t.finalScore != null && t.finalScore >= MASTER_LINE ? '已掌握' : '回到练习'}</b>
                  <small>{t.resolvedAt}</small>
                </div>
              </div>;
            })}
            {resolvedTickets.length === 0 && <div className="empty">还没有复核记录</div>}
            <div className="section-head conflicts-head"><div><h2>冲突记录</h2><p>触发复核规则的操作：句子、原分、新分与规则</p></div></div>
            {conflicts.map(c => <div className="conflict-item" key={c.id}>
              <div className="conflict-rule"><AlertTriangle size={13}/>{c.rule}</div>
              <strong>{c.phraseText}</strong>
              <div className="conflict-scores"><span>原分：{c.oldScore}</span><span>新分：{c.newScore}</span></div>
              <small>{c.time}</small>
            </div>)}
            {conflicts.length === 0 && <div className="empty">暂无冲突记录</div>}
          </section>
        </div>
      </> : <>
        <section className="stats">
          <div><span>本周完成</span><strong>12 <em>/ 20</em></strong><div className="progress"><i style={{ width: '60%' }}/></div></div>
          <div><span>练习时长</span><strong>38 <em>分钟</em></strong><small>比上周多 8 分钟</small></div>
          <div><span>待复核</span><strong>{pendingTickets.length} <em>单</em></strong>{pendingTickets.length > 0 ? <small className="amber link" onClick={() => setView('reviews')}>前往复核中心 →</small> : <small className="green">评分无争议</small>}</div>
        </section>
        <div className="content-grid">
          <section className="library">
            <div className="section-head"><div><h2>句子库</h2><p>选择一句开始你的声音训练</p></div><button className="ghost" onClick={() => setFilter('待练')}>只看待练</button></div>
            <div className="filters">{tags.map(t => <button key={t} className={filter === t ? 'chip active' : 'chip'} onClick={() => setFilter(t)}>{t}</button>)}</div>
            <div className="phrase-list">
              {filtered.map(p => <button key={p.id} onClick={() => selectPhrase(p.id)} className={p.id === selected ? 'phrase selected' : 'phrase'}>
                <div className={p.status === 'review' ? 'phrase-icon review' : 'phrase-icon'}>{p.status === 'mastered' ? <Check size={15}/> : p.status === 'review' ? <AlertTriangle size={15}/> : <Mic size={15}/>}</div>
                <div className="phrase-copy">
                  <strong>{p.text}</strong><span>{p.translation}</span>
                  <div className="phrase-meta"><i>{p.tag}</i><i>{p.level}</i>{p.status === 'review' && <i className="st-review">待复核</i>}{p.status === 'mastered' && <i className="st-mastered">已掌握</i>}{p.attempts > 0 && <small>{p.attempts} 次练习</small>}</div>
                </div>
                <ChevronRight size={17}/>
              </button>)}
              {filtered.length === 0 && <div className="empty">没有找到匹配句子</div>}
            </div>
          </section>
          {current && <section className="practice">
            <div className="practice-head">
              <div><span className="label">CURRENT PHRASE</span><h2>跟着感觉读</h2></div>
              <div className="practice-head-actions">
                {current.status !== 'mastered' && <button className="ghost mark-btn" onClick={markMastered} title={currentPending ? '复核结束前不得标为已掌握' : '标为已掌握'}><Check size={14}/>标为已掌握</button>}
                <button className="icon-btn" onClick={removePhrase} title="删除句子"><Trash2 size={17}/></button>
              </div>
            </div>
            <div className="focus-card">
              <div className="focus-tag">{current.tag} · {current.level} · {STATUS_LABEL[current.status]}</div>
              <p className="focus-text">{current.text}</p>
              <p className="focus-translation">{current.translation}</p>
              <div className="audio-sample"><button className="round-btn" onClick={() => setPlaying(!playing)}>{playing ? <Pause size={18}/> : <Play size={18}/>}</button><div className="sample-wave">{bars.map((h, i) => <i key={i} style={{ height: `${h * (playing ? 1.15 : 0.72)}%` }}/>)}</div><span>0:08</span></div>
            </div>
            <div className="record-card">
              <div className="record-top"><div><span className="label">YOUR RECORDING</span><h3>{recorded ? '录音已保存，听听自己的声音' : '准备好后开始录音'}</h3></div><span className="record-time">{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</span></div>
              <div className="record-wave">{bars.slice(5, 58).map((h, i) => <i key={i} className={recording ? 'live' : ''} style={{ height: `${h * (recording ? (0.4 + ((i % 5) / 7)) : 0.4)}%` }}/>)}</div>
              <div className="record-actions">
                <button className={recording ? 'record-button recording' : 'record-button'} onClick={toggleRecord}><span>{recording ? <Pause size={16}/> : <Mic size={16}/>}</span>{recording ? '结束录音' : recorded ? '重新录音' : '开始录音'}</button>
                {recorded && <button className="secondary" onClick={() => setPlaying(!playing)}>{playing ? <Pause size={15}/> : <Play size={15}/>} 回放</button>}
              </div>
            </div>
            {latestVersion && <div className="score-card">
              <div className="score-grid">
                <div><span>机器分</span><strong>{latestVersion.machineScore ?? '—'}</strong></div>
                <div><span>评审分</span><strong>{latestVersion.reviewerScore ?? '—'}</strong></div>
                <div><span>最终分</span><strong>{latestVersion.finalScore ?? '待定'}</strong></div>
                <div><span>分差</span><strong className={latestVersion.gap != null && latestVersion.gap > GAP_LIMIT ? 'red' : ''}>{latestVersion.gap ?? '—'}</strong></div>
              </div>
              {latestVersion.deductions.length > 0 && <div className="deductions"><span className="deductions-label">扣分项</span>{latestVersion.deductions.map(d => <span key={d.item} className="deduction-chip">{d.item} −{d.points}</span>)}</div>}
              {latestVersion.note && <p className="version-note">复核调整依据：{latestVersion.note}{latestVersion.basedOn ? `（基于 v${latestVersion.basedOn}）` : ''}</p>}
              {currentPending
                ? <div className="banner warn"><AlertTriangle size={15}/><p>机器分与评审分相差 {currentPending.gap} 分（&gt; {GAP_LIMIT} 分），已进入待复核，复核完成前本句不可标为已掌握。</p><button className="banner-btn" onClick={() => setView('reviews')}>前往复核</button></div>
                : latestVersion.finalScore != null && <div className={latestVersion.finalScore >= MASTER_LINE ? 'banner ok' : 'banner info'}><Check size={15}/><p>{latestVersion.finalScore >= MASTER_LINE ? `最终分 ${latestVersion.finalScore} 达到掌握线（${MASTER_LINE} 分），已标为已掌握。` : `最终分 ${latestVersion.finalScore} 未达掌握线（${MASTER_LINE} 分），继续练习。`}</p></div>}
            </div>}
            {currentVersions.length > 0 && <div className="versions-card">
              <div className="versions-head"><History size={15}/><h3>录音版本</h3><span>{currentVersions.length} 个版本 · 旧录音旧分均可回查</span></div>
              {[...currentVersions].reverse().map(v => <div className="version-row" key={v.id}>
                <span className={v.id === latestVersion?.id ? 'version-badge current' : 'version-badge'}>v{v.version}</span>
                <div className="version-main">
                  <div className="version-title"><b>{v.source === 'review' ? '复核调整' : '练习录音'}</b>{v.id === latestVersion?.id && <i className="current-tag">当前</i>}<small>{v.createdAt}</small></div>
                  <div className="version-scores">
                    {v.machineScore != null && <span>机器 {v.machineScore}</span>}
                    {v.reviewerScore != null && <span>评审 {v.reviewerScore}</span>}
                    <span>最终 {v.finalScore ?? '待定'}</span>
                    {v.gap != null && v.gap > GAP_LIMIT && <span className="red">分差 {v.gap}</span>}
                  </div>
                  {v.deductions.length > 0 && <div className="version-deductions">{v.deductions.map(d => `${d.item} −${d.points}`).join(' · ')}</div>}
                  {v.note && <div className="version-note">依据：{v.note}{v.basedOn ? `（基于 v${v.basedOn} 调整）` : ''}</div>}
                </div>
                <button className="icon-btn" title="回放该版本录音" onClick={() => setPlaying(!playing)}><Play size={14}/></button>
              </div>)}
            </div>}
            <div className="tip"><span>练习小贴士</span><p>放慢速度，先把每个音节读清楚，再自然地连起来。</p><RotateCcw size={15}/></div>
          </section>}
        </div>
      </>}
    </main>

    {showAdd && <div className="modal-backdrop" onClick={() => setShowAdd(false)}><div className="modal" onClick={e => e.stopPropagation()}><div className="modal-head"><h2>添加练习句子</h2><button className="icon-btn" onClick={() => setShowAdd(false)}>×</button></div><label>英文句子<textarea autoFocus value={newText} onChange={e => setNewText(e.target.value)} placeholder="例如：I can make this happen."/></label><div className="modal-actions"><button className="secondary" onClick={() => setShowAdd(false)}>取消</button><button className="primary" onClick={addPhrase}>加入句子库</button></div></div></div>}

    {conflictModal && <div className="modal-backdrop" onClick={() => setConflictModal(null)}><div className="modal" onClick={e => e.stopPropagation()}>
      <div className="modal-head"><h2>评分冲突提醒</h2><button className="icon-btn" onClick={() => setConflictModal(null)}>×</button></div>
      <p className="modal-sub">以下操作触发了复核规则，已按规则处理：</p>
      {conflictModal.map(c => <div className="conflict-item" key={c.id}>
        <div className="conflict-rule"><AlertTriangle size={13}/>{c.rule}</div>
        <strong>{c.phraseText}</strong>
        <div className="conflict-scores"><span>原分：{c.oldScore}</span><span>新分：{c.newScore}</span></div>
      </div>)}
      <div className="modal-actions"><button className="primary" onClick={() => setConflictModal(null)}>知道了</button></div>
    </div></div>}
  </div>;
}
