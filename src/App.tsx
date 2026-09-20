import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronRight, ClipboardCheck, Clock3, History, Mic, Pause, Play, Plus, RotateCcw, Scale, Search, Trash2, Volume2 } from 'lucide-react';

const MASTER_LINE = 85; // 掌握线：有效分达到 85 才允许标为已掌握
const GAP_LIMIT = 8;    // 机器分与评审分分差超过 8 分必须进入复核

type PhraseStatus = 'new' | 'practice' | 'mastered' | 'review';
type Phrase = { id: number; text: string; translation: string; tag: string; level: '入门' | '进阶' | '挑战'; status: PhraseStatus; attempts: number; last?: string };
type Deduction = { item: string; points: number };
type Version = { id: string; phraseId: number; at: string; machine: number; reviewer: number; deductions: Deduction[]; kind: 'practice' | 'adjusted'; note?: string };
type Ticket = { id: string; phraseId: number; versionId: string; machine: number; reviewer: number; gap: number; rule: string; status: 'pending' | 'confirmed' | 'adjusted'; at: string; resolvedAt?: string; adjusted?: number; reason?: string };
type Conflict = { id: string; phraseId: number; text: string; original: number; incoming: number; rule: string; at: string };

const seed: Phrase[] = [
  { id: 1, text: 'The morning light feels different today.', translation: '今天的晨光感觉不一样。', tag: '日常', level: '入门', status: 'practice', attempts: 3, last: '今天 09:24' },
  { id: 2, text: 'Could you walk me through the next step?', translation: '你能带我了解下一步吗？', tag: '工作', level: '进阶', status: 'new', attempts: 0 },
  { id: 3, text: 'I appreciate your patience and thoughtful feedback.', translation: '感谢你的耐心和细致反馈。', tag: '表达', level: '挑战', status: 'mastered', attempts: 8, last: '昨天 18:10' },
  { id: 4, text: 'Let’s make room for a little curiosity.', translation: '给好奇心留一点空间。', tag: '灵感', level: '入门', status: 'new', attempts: 0 },
];
const bars = Array.from({ length: 68 }, (_, i) => 18 + ((i * 29) % 44));
const deductionPool: Deduction[] = [
  { item: '元音饱满度不足', points: 5 },
  { item: '尾音吞音', points: 4 },
  { item: '连读不自然', points: 3 },
  { item: '语速过快', points: 3 },
  { item: '重音位置偏差', points: 2 },
];
const statusLabel: Record<PhraseStatus, string> = { new: '未开始', practice: '练习中', mastered: '已掌握', review: '待复核' };
const now = () => new Date().toLocaleString('zh-CN', { hour12: false });
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

function load<T>(key: string, fallback: T): T {
  try { const v = JSON.parse(localStorage.getItem(key) || ''); return v ?? fallback; } catch { return fallback; }
}
// 刷新后校正：有待复核单的句子必须是“待复核”，且不得保持“已掌握”
function reconcile(phrases: Phrase[], tickets: Ticket[]): Phrase[] {
  return phrases.map(p => {
    const pending = tickets.some(t => t.phraseId === p.id && t.status === 'pending');
    if (pending) return { ...p, status: 'review' as PhraseStatus };
    if (p.status === 'review') return { ...p, status: 'practice' as PhraseStatus };
    return p;
  });
}
function buildDeductions(machine: number): Deduction[] {
  let remain = 100 - machine;
  const out: Deduction[] = [];
  for (const d of deductionPool) {
    if (remain >= d.points && out.length < 3) { out.push(d); remain -= d.points; }
  }
  return out;
}

export default function App() {
  const [tickets, setTickets] = useState<Ticket[]>(() => load('sound-lab-tickets', []));
  const [phrases, setPhrases] = useState<Phrase[]>(() => reconcile(load('sound-lab-phrases', seed), load('sound-lab-tickets', [])));
  const [versions, setVersions] = useState<Version[]>(() => load('sound-lab-versions', []));
  const [conflicts, setConflicts] = useState<Conflict[]>(() => load('sound-lab-conflicts', []));
  const [view, setView] = useState<'library' | 'review'>('library');
  const [selected, setSelected] = useState(phrases[0]?.id ?? 1);
  const [filter, setFilter] = useState('全部');
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState(false);
  const [playing, setPlaying] = useState<number | string | null>(null);
  const [recorded, setRecorded] = useState(false);
  const [seconds, setSeconds] = useState(0);
  const [showAdd, setShowAdd] = useState(false);
  const [newText, setNewText] = useState('');
  const timer = useRef<number | undefined>(undefined);

  const current = phrases.find(p => p.id === selected) ?? phrases[0];
  const currentVersions = useMemo(() => versions.filter(v => v.phraseId === current?.id).slice().reverse(), [versions, current]);
  const latest = currentVersions[0];
  const pendingTicket = tickets.find(t => t.phraseId === current?.id && t.status === 'pending');
  const pendingTickets = tickets.filter(t => t.status === 'pending');
  const resolvedTickets = tickets.filter(t => t.status !== 'pending').slice().reverse();
  const filtered = useMemo(() => phrases.filter(p =>
    (filter === '全部' || p.tag === filter || p.level === filter ||
      (filter === '待练' && p.status !== 'mastered') ||
      (filter === '待复核' && p.status === 'review') ||
      (filter === '已掌握' && p.status === 'mastered')) &&
    p.text.toLowerCase().includes(query.toLowerCase())), [phrases, filter, query]);
  const tags = ['全部', ...Array.from(new Set(phrases.map(p => p.tag))), '待复核', '已掌握'];

  useEffect(() => { localStorage.setItem('sound-lab-phrases', JSON.stringify(phrases)); }, [phrases]);
  useEffect(() => { localStorage.setItem('sound-lab-versions', JSON.stringify(versions)); }, [versions]);
  useEffect(() => { localStorage.setItem('sound-lab-tickets', JSON.stringify(tickets)); }, [tickets]);
  useEffect(() => { localStorage.setItem('sound-lab-conflicts', JSON.stringify(conflicts)); }, [conflicts]);
  useEffect(() => () => window.clearInterval(timer.current), []);

  const startRecord = () => {
    if (!recording) {
      setSeconds(0); setRecording(true);
      timer.current = window.setInterval(() => setSeconds(s => s + 1), 1000);
      return;
    }
    // 结束录音：保存机器分、评审分、录音版本与扣分项
    window.clearInterval(timer.current);
    setRecording(false); setRecorded(true);
    if (!current) return;
    const machine = 62 + ((current.id * 13 + current.attempts * 17) % 37);
    const reviewer = clamp(machine + (((current.id * 7 + current.attempts * 11) % 25) - 12), 40, 100);
    const seq = versions.filter(v => v.phraseId === current.id).length + 1;
    const version: Version = { id: `v${seq}`, phraseId: current.id, at: now(), machine, reviewer, deductions: buildDeductions(machine), kind: 'practice' };
    const gap = Math.abs(machine - reviewer);
    const existing = tickets.find(t => t.phraseId === current.id && t.status === 'pending');
    let status: PhraseStatus;
    if (gap > GAP_LIMIT) {
      if (existing) {
        // 同一句已有待复核单：不重复开单，记录冲突（句子、原分、新分、触发规则）
        setConflicts(cs => [...cs, { id: `C${Date.now()}`, phraseId: current.id, text: current.text, original: existing.reviewer, incoming: reviewer, rule: `分差 ${gap} 分 > ${GAP_LIMIT} 分，且该句已有待复核单 ${existing.id}`, at: now() }]);
      } else {
        setTickets(ts => [...ts, { id: `R${String(ts.length + 1).padStart(2, '0')}`, phraseId: current.id, versionId: version.id, machine, reviewer, gap, rule: `机器分与评审分相差 ${gap} 分（> ${GAP_LIMIT} 分）`, status: 'pending', at: now() }]);
      }
      status = 'review'; // 复核结束前不得标为已掌握
    } else {
      status = reviewer >= MASTER_LINE ? 'mastered' : 'practice';
    }
    setVersions(vs => [...vs, version]);
    setPhrases(ps => ps.map(p => p.id === current.id ? { ...p, attempts: p.attempts + 1, status, last: '刚刚' } : p));
  };

  // 评审确认原分
  const confirmTicket = (t: Ticket) => {
    setTickets(ts => ts.map(x => x.id === t.id ? { ...x, status: 'confirmed', resolvedAt: now() } : x));
    setPhrases(ps => ps.map(p => p.id === t.phraseId ? { ...p, status: t.reviewer >= MASTER_LINE ? 'mastered' : 'practice' } : p));
  };
  // 评审调整分数：生成带原因的新版本，旧录音与旧分保留可查
  const adjustTicket = (t: Ticket, score: number, reason: string) => {
    const seq = versions.filter(v => v.phraseId === t.phraseId).length + 1;
    setVersions(vs => [...vs, { id: `v${seq}`, phraseId: t.phraseId, at: now(), machine: t.machine, reviewer: score, deductions: [], kind: 'adjusted', note: reason }]);
    setTickets(ts => ts.map(x => x.id === t.id ? { ...x, status: 'adjusted', resolvedAt: now(), adjusted: score, reason } : x));
    setPhrases(ps => ps.map(p => p.id === t.phraseId ? { ...p, status: score >= MASTER_LINE ? 'mastered' : 'practice' } : p)); // 低于掌握线回到练习中
  };
  const markMastered = () => {
    if (!current || pendingTicket || !latest || latest.reviewer < MASTER_LINE) return;
    setPhrases(ps => ps.map(p => p.id === current.id ? { ...p, status: 'mastered' } : p));
  };
  const addPhrase = () => { if (!newText.trim()) return; const id = Date.now(); setPhrases(ps => [...ps, { id, text: newText.trim(), translation: '待补充译文', tag: '自定义', level: '入门', status: 'new', attempts: 0 }]); setSelected(id); setNewText(''); setShowAdd(false); };
  const removePhrase = () => { if (!current) return; setPhrases(ps => ps.filter(p => p.id !== current.id)); setSelected(filtered.find(p => p.id !== current.id)?.id ?? phrases.find(p => p.id !== current.id)?.id ?? 0); };
  const openPhrase = (id: number) => { setSelected(id); setRecorded(false); setView('library'); };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><Volume2 size={19} /></div><div><strong>声线练习室</strong><span>Pronounce / practice</span></div></div>
      <div className="side-label">我的练习</div>
      <nav>
        <button className={view === 'library' ? 'side-link active' : 'side-link'} onClick={() => { setView('library'); setFilter('全部'); }}><Mic size={17} />练习库 <b>{phrases.length}</b></button>
        <button className={view === 'review' ? 'side-link active' : 'side-link'} onClick={() => setView('review')}><Scale size={17} />复核待办 {pendingTickets.length > 0 && <b className="badge-warn">{pendingTickets.length}</b>}</button>
        <button className="side-link" onClick={() => { setView('library'); setFilter('已掌握'); }}><Check size={17} />已掌握 <b>{phrases.filter(p => p.status === 'mastered').length}</b></button>
        <button className="side-link" onClick={() => { setView('library'); setFilter('待复核'); }}><Clock3 size={17} />待复核 <b>{phrases.filter(p => p.status === 'review').length}</b></button>
      </nav>
      <div className="sidebar-foot"><div className="streak"><span>连续练习</span><strong>5 <small>天</small></strong><i>↗ +2</i></div><div className="profile"><div className="avatar">YL</div><div><strong>Yuki Lin</strong><span>普通计划</span></div><ChevronRight size={16} /></div></div>
    </aside>
    <main className="main">
      {view === 'library' ? <>
        <header className="topbar"><div><p className="eyebrow">WEDNESDAY, SEP 12</p><h1>今天练什么？</h1></div><div className="top-actions"><div className="search"><Search size={16} /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索句子" /></div><button className="primary" onClick={() => setShowAdd(true)}><Plus size={17} />添加句子</button></div></header>
        <section className="stats">
          <div><span>本周完成</span><strong>12 <em>/ 20</em></strong><div className="progress"><i style={{ width: '60%' }} /></div></div>
          <div><span>待复核</span><strong>{pendingTickets.length} <em>单</em></strong><small>{pendingTickets.length > 0 ? '复核完成前不可标为已掌握' : '没有待处理的评分争议'}</small></div>
          <div><span>最佳发音</span><strong>92 <em>分</em></strong><small className="green">↑ 6 分</small></div>
        </section>
        <div className="content-grid">
          <section className="library">
            <div className="section-head"><div><h2>句子库</h2><p>选择一句开始你的声音训练</p></div><button className="ghost" onClick={() => setFilter('待练')}>只看待练</button></div>
            <div className="filters">{tags.map(t => <button key={t} className={filter === t ? 'chip active' : 'chip'} onClick={() => setFilter(t)}>{t}</button>)}</div>
            <div className="phrase-list">{filtered.map(p => <button key={p.id} onClick={() => openPhrase(p.id)} className={p.id === selected ? 'phrase selected' : 'phrase'}>
              <div className="phrase-icon">{p.status === 'mastered' ? <Check size={15} /> : p.status === 'review' ? <Scale size={15} /> : <Mic size={15} />}</div>
              <div className="phrase-copy"><strong>{p.text}</strong><span>{p.translation}</span><div className="phrase-meta"><i>{p.tag}</i><i>{p.level}</i>{p.status === 'review' && <i className="tag-review">待复核</i>}{p.attempts > 0 && <small>{p.attempts} 次练习</small>}</div></div>
              <ChevronRight size={17} /></button>)}
              {filtered.length === 0 && <div className="empty">没有找到匹配句子</div>}</div>
          </section>
          {current && <section className="practice">
            <div className="practice-head"><div><span className="label">CURRENT PHRASE</span><h2>跟着感觉读</h2></div><button className="icon-btn" onClick={removePhrase} title="删除句子"><Trash2 size={17} /></button></div>
            <div className="focus-card"><div className="focus-tag">{current.tag} · {current.level} · {statusLabel[current.status]}</div><p className="focus-text">{current.text}</p><p className="focus-translation">{current.translation}</p><div className="audio-sample"><button className="round-btn" onClick={() => setPlaying(playing === 'sample' ? null : 'sample')}>{playing === 'sample' ? <Pause size={18} /> : <Play size={18} />}</button><div className="sample-wave">{bars.map((h, i) => <i key={i} style={{ height: `${h * (playing === 'sample' ? 1.15 : 0.72)}%` }} />)}</div><span>0:08</span></div></div>
            {pendingTicket && <div className="review-banner"><AlertTriangle size={16} /><div><strong>评分争议待复核</strong><span>机器分 {pendingTicket.machine} 与评审分 {pendingTicket.reviewer} 相差 {pendingTicket.gap} 分，复核完成前本句不可标为已掌握。</span></div><button className="secondary" onClick={() => setView('review')}>去复核</button></div>}
            <div className="record-card">
              <div className="record-top"><div><span className="label">YOUR RECORDING</span><h3>{recorded ? '录音已保存，听听自己的声音' : '准备好后开始录音'}</h3></div><span className="record-time">{String(Math.floor(seconds / 60)).padStart(2, '0')}:{String(seconds % 60).padStart(2, '0')}</span></div>
              <div className="record-wave">{bars.slice(5, 58).map((h, i) => <i key={i} className={recording ? 'live' : ''} style={{ height: `${h * (recording ? (0.4 + ((i % 5) / 7)) : 0.4)}%` }} />)}</div>
              <div className="record-actions">
                <button className={recording ? 'record-button recording' : 'record-button'} onClick={startRecord}><span>{recording ? <Pause size={16} /> : <Mic size={16} />}</span>{recording ? '结束录音' : recorded ? '重新录音' : '开始录音'}</button>
                {recorded && <button className="secondary" onClick={() => setPlaying(playing === 'latest' ? null : 'latest')}>{playing === 'latest' ? <Pause size={15} /> : <Play size={15} />} 回放</button>}
                <button className="secondary" disabled={!!pendingTicket || !latest || latest.reviewer < MASTER_LINE} title={pendingTicket ? '复核结束前不得标为已掌握' : !latest || latest.reviewer < MASTER_LINE ? `有效分需达到掌握线 ${MASTER_LINE} 分` : '标为已掌握'} onClick={markMastered}><Check size={15} /> 标为已掌握</button>
              </div>
            </div>
            {latest && <div className="score-card">
              <div className="score-head"><span className="label">LATEST SCORE · {latest.id.toUpperCase()}{latest.kind === 'adjusted' ? '（复核调整）' : ''}</span>{Math.abs(latest.machine - latest.reviewer) > GAP_LIMIT && latest.kind === 'practice' && <span className="gap-flag">分差 {Math.abs(latest.machine - latest.reviewer)} 分</span>}</div>
              <div className="score-grid">
                <div><span>机器分</span><strong>{latest.machine}</strong></div>
                <div><span>评审分</span><strong>{latest.reviewer}</strong></div>
                <div><span>掌握线</span><strong>{MASTER_LINE}</strong></div>
              </div>
              {latest.note && <p className="adjust-note">调整依据：{latest.note}</p>}
              {latest.deductions.length > 0 && <div className="deductions">{latest.deductions.map(d => <span key={d.item} className="deduction">{d.item} <b>-{d.points}</b></span>)}</div>}
            </div>}
            {currentVersions.length > 0 && <div className="version-card">
              <div className="version-head"><History size={14} /><span>录音版本 · {currentVersions.length}</span><small>旧录音与旧分均可查</small></div>
              {currentVersions.map(v => <div key={v.id + v.at} className="version-row">
                <button className="round-btn small" onClick={() => setPlaying(playing === v.id + v.at ? null : v.id + v.at)}>{playing === v.id + v.at ? <Pause size={13} /> : <Play size={13} />}</button>
                <span className="v-id">{v.id}</span>
                <span className={v.kind === 'adjusted' ? 'v-kind adjusted' : 'v-kind'}>{v.kind === 'adjusted' ? '复核调整' : '练习'}</span>
                <span className="v-score">机器 {v.machine} · 评审 {v.reviewer}</span>
                {v.note && <span className="v-note" title={v.note}>{v.note}</span>}
                <span className="v-at">{v.at}</span>
              </div>)}
            </div>}
            <div className="tip"><span>练习小贴士</span><p>放慢速度，先把每个音节读清楚，再自然地连起来。</p><RotateCcw size={15} /></div>
          </section>}
        </div>
      </> : <>
        <header className="topbar"><div><p className="eyebrow">SCORE REVIEW</p><h1>评分争议复核</h1></div></header>
        <section className="stats four">
          <div><span>待复核</span><strong>{pendingTickets.length} <em>单</em></strong><small>分差超过 {GAP_LIMIT} 分自动进入</small></div>
          <div><span>已确认原分</span><strong>{tickets.filter(t => t.status === 'confirmed').length} <em>单</em></strong><small>评审确认机器/评审分有效</small></div>
          <div><span>已调整</span><strong>{tickets.filter(t => t.status === 'adjusted').length} <em>单</em></strong><small>生成带原因的新版本</small></div>
          <div><span>开单冲突</span><strong>{conflicts.length} <em>次</em></strong><small>同句已有待复核单</small></div>
        </section>
        <section className="review-panel">
          <div className="section-head"><div><h2>待复核</h2><p>确认原分，或填写调整分与依据；低于掌握线 {MASTER_LINE} 分将回到练习中</p></div></div>
          {pendingTickets.length === 0 && <div className="empty">暂无待复核的评分争议</div>}
          {pendingTickets.map(t => {
            const phrase = phrases.find(p => p.id === t.phraseId);
            const version = versions.find(v => v.phraseId === t.phraseId && v.id === t.versionId);
            return <TicketCard key={t.id} ticket={t} text={phrase?.text ?? '（句子已删除）'} deductions={version?.deductions ?? []} onConfirm={() => confirmTicket(t)} onAdjust={(s, r) => adjustTicket(t, s, r)} />;
          })}
        </section>
        {conflicts.length > 0 && <section className="review-panel">
          <div className="section-head"><div><h2>开单冲突</h2><p>同一句已有待复核单，新争议不重复开单，记录如下</p></div></div>
          <div className="conflict-head conflict-row"><span>句子</span><span>原分</span><span>新分</span><span>触发规则</span><span>时间</span></div>
          {conflicts.slice().reverse().map(c => <div key={c.id} className="conflict-row">
            <button className="link" onClick={() => openPhrase(c.phraseId)}>{c.text}</button>
            <span>{c.original}</span><span>{c.incoming}</span><span className="c-rule">{c.rule}</span><span className="v-at">{c.at}</span>
          </div>)}
        </section>}
        {resolvedTickets.length > 0 && <section className="review-panel">
          <div className="section-head"><div><h2>复核记录</h2><p>已结束的复核单与处理结果</p></div></div>
          {resolvedTickets.map(t => {
            const phrase = phrases.find(p => p.id === t.phraseId);
            return <div key={t.id} className="resolved-row">
              <ClipboardCheck size={15} />
              <div className="resolved-main"><strong>{phrase?.text ?? '（句子已删除）'}</strong><span>{t.id} · 机器 {t.machine} / 评审 {t.reviewer} · 分差 {t.gap}</span>{t.status === 'adjusted' && <span className="c-rule">调整为 {t.adjusted} 分 · 依据：{t.reason}</span>}</div>
              <span className={t.status === 'adjusted' ? 'v-kind adjusted' : 'v-kind'}>{t.status === 'adjusted' ? '已调整' : '确认原分'}</span>
              <span className="v-at">{t.resolvedAt}</span>
            </div>;
          })}
        </section>}
      </>}
    </main>
    {showAdd && <div className="modal-backdrop" onClick={() => setShowAdd(false)}><div className="modal" onClick={e => e.stopPropagation()}><div className="modal-head"><h2>添加练习句子</h2><button className="icon-btn" onClick={() => setShowAdd(false)}>×</button></div><label>英文句子<textarea autoFocus value={newText} onChange={e => setNewText(e.target.value)} placeholder="例如：I can make this happen." /></label><div className="modal-actions"><button className="secondary" onClick={() => setShowAdd(false)}>取消</button><button className="primary" onClick={addPhrase}>加入句子库</button></div></div></div>}
  </div>;
}

function TicketCard({ ticket, text, deductions, onConfirm, onAdjust }: { ticket: Ticket; text: string; deductions: Deduction[]; onConfirm: () => void; onAdjust: (score: number, reason: string) => void }) {
  const [mode, setMode] = useState<'idle' | 'adjust'>('idle');
  const [score, setScore] = useState(String(ticket.reviewer));
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const submit = () => {
    const n = Number(score);
    if (!Number.isFinite(n) || n < 0 || n > 100) { setError('调整分需为 0–100 的数字'); return; }
    if (!reason.trim()) { setError('请填写调整依据'); return; }
    onAdjust(Math.round(n), reason.trim());
  };
  return <div className="ticket">
    <div className="ticket-main">
      <div className="ticket-top"><span className="v-id">{ticket.id}</span><span className="c-rule">{ticket.rule}</span><span className="v-at">{ticket.at}</span></div>
      <strong className="ticket-text">{text}</strong>
      <div className="score-grid inline">
        <div><span>机器分</span><strong>{ticket.machine}</strong></div>
        <div><span>评审分</span><strong>{ticket.reviewer}</strong></div>
        <div><span>分差</span><strong className="warn-text">{ticket.gap}</strong></div>
      </div>
      {deductions.length > 0 && <div className="deductions">{deductions.map(d => <span key={d.item} className="deduction">{d.item} <b>-{d.points}</b></span>)}</div>}
    </div>
    <div className="ticket-actions">
      {mode === 'idle' ? <>
        <button className="primary" onClick={onConfirm}><Check size={15} />确认原分 {ticket.reviewer}</button>
        <button className="secondary" onClick={() => setMode('adjust')}>调整分数</button>
      </> : <>
        <div className="adjust-form">
          <label>调整分<input type="number" min={0} max={100} value={score} onChange={e => setScore(e.target.value)} /></label>
          <label>调整依据<textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="例如：尾音吞音为口音习惯，不影响理解，评审分上调" /></label>
          {error && <span className="form-error">{error}</span>}
          <div className="modal-actions"><button className="secondary" onClick={() => { setMode('idle'); setError(''); }}>取消</button><button className="primary" onClick={submit}>提交调整</button></div>
        </div>
      </>}
    </div>
  </div>;
}
