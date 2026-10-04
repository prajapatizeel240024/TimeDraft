// npm run fixtures [-- --seed 42]
// Builds 12 synthetic days in two steps: plan the true work blocks, then render the emails, calendar
// events, doc sessions and calls those blocks would leave behind. The answer key is written from the
// plan, never from the rendered text. Rendering is template-based, so fixtures are reproducible and free.
import fs from 'node:fs';
import path from 'node:path';
import { loadFirm } from '@/lib/config';
import { AnswerKeySchema, DayFixtureSchema, type AnswerKey, type DayFixture } from '@/lib/schemas';

type TrapKind = AnswerKey['traps'][number]['kind'];
type Rng = () => number;

function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const int = (r: Rng, lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
const pick = <T,>(r: Rng, items: readonly T[]): T => items[Math.floor(r() * items.length)];
function shuffle<T>(r: Rng, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const DATES = ['2026-03-05', '2026-03-06', '2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13', '2026-03-16', '2026-03-17', '2026-03-18', '2026-03-19', '2026-03-20', '2026-03-23'];
const pad = (n: number) => String(n).padStart(2, '0');
const offsetFor = (date: string) => (date >= '2026-03-08' ? '-04:00' : '-05:00'); // US DST starts Mar 8, 2026
const iso = (date: string, sec: number) => `${date}T${pad(Math.floor(sec / 3600))}:${pad(Math.floor((sec % 3600) / 60))}:${pad(sec % 60)}${offsetFor(date)}`;
const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const MIN = 60;

const DANA = 'dwhitfield@ashgrove.example';
const P = {
  moss: { email: 'jmoss@kestrel.example', phone: '+1-212-555-0141' },
  vance: { email: 'gvance@pryorvance.example', phone: '+1-212-555-0162' },
  chu: { email: 'lchu@halberd.example', phone: '+1-617-555-0133' },
  kessler: { email: 'ekessler@graykessler.example', phone: '+1-917-555-0128' },
  holt: { email: 'dholt@bellhaven.example', phone: '+1-646-555-0150' },
  amaro: { email: 'namaro@amarolutz.example', phone: '+1-718-555-0119' },
  strand: { email: 'estrand@strandadr.example', phone: '+1-212-555-0175' },
  park: { email: 'lpark@brightline.example', phone: '+1-646-555-0187' },
  calloway: { email: 'rcalloway@ashgrove.example' },
  reyes: { email: 'treyes@ashgrove.example' },
  billing: { email: 'billing@ashgrove.example' },
  it: { email: 'it-help@ashgrove.example', phone: '+1-212-555-0100' },
  cle: { email: 'cle@ashgrove.example' },
} as const;
const F1 = '/Matters/M-1001 Kestrel v Calder/';
const F2 = '/Matters/M-1002 Halberd v Ostrander/';
const F3 = '/Matters/M-1003 Ruiz v Bellhaven/';

// ---------- rendering context ----------

interface Ctx {
  date: string;
  tag: string;
  r: Rng;
  fx: DayFixture;
  key: AnswerKey;
  counters: { e: number; c: number; d: number; p: number; t: number };
}

function newId(ctx: Ctx, kind: 'e' | 'c' | 'd' | 'p'): string {
  ctx.counters[kind] += 1;
  return `${ctx.tag}${kind}${pad(ctx.counters[kind])}`;
}
function newThread(ctx: Ctx): string {
  ctx.counters.t += 1;
  return `${ctx.tag}t${pad(ctx.counters.t)}`;
}

function email(ctx: Ctx, block: string | null, e: { direction: 'sent' | 'received'; from: string; to: string[]; cc?: string[]; subject: string; body: string; at: number; opened?: number | null; attachments?: string[]; thread?: string }): string {
  const id = newId(ctx, 'e');
  ctx.fx.emails.push({
    id,
    thread_id: e.thread ?? newThread(ctx),
    direction: e.direction,
    from: e.from,
    to: e.to,
    cc: e.cc ?? [],
    subject: e.subject,
    body: e.body,
    at: iso(ctx.date, Math.max(6 * 3600, e.at)),
    opened_at: e.direction === 'received' && e.opened !== null ? iso(ctx.date, e.opened ?? e.at) : '',
    attachments: e.attachments ?? [],
  });
  ctx.key.activities[id] = { block_id: block };
  return id;
}

function cal(ctx: Ctx, block: string | null, c: { title: string; start: number; end: number; attendees: string[]; response?: 'accepted' | 'declined' | 'tentative'; description?: string }): string {
  const id = newId(ctx, 'c');
  ctx.fx.calendar.push({ id, title: c.title, start: iso(ctx.date, c.start), end: iso(ctx.date, c.end), attendees: c.attendees, response: c.response ?? 'accepted', description: c.description ?? '' });
  ctx.key.activities[id] = { block_id: block };
  return id;
}

function doc(ctx: Ctx, block: string, d: { path: string; start: number; end: number }): string {
  const id = newId(ctx, 'd');
  const span = d.end - d.start;
  const ratio = 0.86 + ctx.r() * 0.1;
  ctx.fx.doc_sessions.push({ id, path: d.path, title: d.path.split('/').pop() ?? d.path, start: iso(ctx.date, d.start), end: iso(ctx.date, d.end), active_seconds: Math.round(span * ratio) });
  ctx.key.activities[id] = { block_id: block };
  return id;
}

function call(ctx: Ctx, block: string, c: { number: string; start: number; duration: number; direction: 'in' | 'out' }): string {
  const id = newId(ctx, 'p');
  ctx.fx.calls.push({ id, direction: c.direction, number: c.number, start: iso(ctx.date, c.start), duration_seconds: c.duration });
  ctx.key.activities[id] = { block_id: block };
  return id;
}

/** Real time to read and answer a short email in this synthetic world: 180-260 wpm reading, 25-45 wpm writing, plus thinking. */
function emailWork(ctx: Ctx, readText: string, replyText: string): number {
  const read = (words(readText) / (180 + ctx.r() * 80)) * MIN;
  const write = (words(replyText) / (25 + ctx.r() * 20)) * MIN;
  return Math.round(read + write + int(ctx.r, 60, 180));
}

// ---------- templates ----------

interface Rendered {
  end: number;
  trueSeconds: number;
  ids: string[];
}

interface Template {
  key: string;
  family: string;
  matter: string | null;
  category: 'billable' | 'admin' | 'personal';
  task: string;
  act: string;
  minutes: [number, number];
  summary: string;
  signal?: 'strong' | 'weak' | 'none';
  thin?: boolean;
  draftNarrative?: string;
  render(ctx: Ctx, block: string, start: number, minutes: number): Rendered;
}

function docOnly(path: string): Template['render'] {
  return (ctx, block, start, minutes) => {
    const end = start + minutes * MIN;
    return { end, trueSeconds: end - start, ids: [doc(ctx, block, { path, start, end })] };
  };
}

function docThenSend(path: string, to: string, subject: string, body: string): Template['render'] {
  return (ctx, block, start, minutes) => {
    const end = start + minutes * MIN;
    const d = doc(ctx, block, { path, start, end: end - 6 * MIN });
    const e = email(ctx, block, { direction: 'sent', from: DANA, to: [to], subject, body, at: end - MIN, attachments: [path.split('/').pop() ?? path] });
    return { end, trueSeconds: end - start, ids: [d, e] };
  };
}

function reviewWithDoc(from: string, subject: string, body: string, attachment: string, docPath: string): Template['render'] {
  return (ctx, block, start, minutes) => {
    const end = start + minutes * MIN;
    const e = email(ctx, block, { direction: 'received', from, to: [DANA], subject, body, at: start - int(ctx.r, 20, 180) * MIN, opened: start, attachments: [attachment] });
    const d = doc(ctx, block, { path: docPath, start: start + 2 * MIN, end });
    return { end, trueSeconds: end - start, ids: [e, d] };
  };
}

function reviewEmailOnly(from: string, subject: string, body: string, attachments: string[]): Template['render'] {
  return (ctx, block, start, minutes) => {
    const end = start + minutes * MIN;
    const e = email(ctx, block, { direction: 'received', from, to: [DANA], subject, body, at: start - int(ctx.r, 15, 120) * MIN, opened: start, attachments });
    return { end, trueSeconds: end - start, ids: [e] };
  };
}

function calendarOnly(title: string, attendees: string[], description = ''): Template['render'] {
  return (ctx, block, start, minutes) => {
    const end = start + minutes * MIN;
    return { end, trueSeconds: end - start, ids: [cal(ctx, block, { title, start, end, attendees: [...attendees, DANA], description })] };
  };
}

function phoneOnly(number: string, direction: 'in' | 'out'): Template['render'] {
  return (ctx, block, start, minutes) => {
    const duration = minutes * MIN + int(ctx.r, 0, 59);
    return { end: start + duration, trueSeconds: duration, ids: [call(ctx, block, { number, start, duration, direction })] };
  };
}

function thread(from: string, subject: string, body: string, reply: string): Template['render'] {
  return (ctx, block, start) => {
    const t = newThread(ctx);
    const a = email(ctx, block, { direction: 'received', from, to: [DANA], subject, body, at: start - int(ctx.r, 10, 150) * MIN, opened: start, thread: t });
    const work = emailWork(ctx, body, reply);
    const b = email(ctx, block, { direction: 'sent', from: DANA, to: [from], subject: `Re: ${subject}`, body: reply, at: start + work, thread: t });
    return { end: start + work, trueSeconds: work, ids: [a, b] };
  };
}

const T: Template[] = [
  // ----- M-1001 Kestrel Logistics v. Calder Freight Lines (discovery) -----
  {
    key: 'k_interrog_draft', family: 'k_interrog', matter: 'M-1001', category: 'billable', task: 'L310', act: 'A103', minutes: [70, 150],
    summary: "Draft responses and objections to Calder Freight's First Set of Interrogatories (Nos. 1-9).",
    render: docThenSend(`${F1}Responses to Calder First Set of Interrogatories.docx`, P.moss.email, 'Draft interrogatory responses for your review',
      "Janet,\n\nAttached are our draft responses and objections to Calder's First Set of Interrogatories. Could you confirm the dispatch dates we give in Nos. 4-7 before Friday?\n\nThanks,\nDana"),
  },
  {
    key: 'k_depo_outline', family: 'k_depo', matter: 'M-1001', category: 'billable', task: 'L330', act: 'A101', minutes: [45, 120],
    summary: "Prepare outline for Rule 30(b)(6) deposition of Calder Freight Lines' corporate designee.",
    render: docOnly(`${F1}Calder 30(b)(6) Deposition Outline.docx`),
  },
  {
    key: 'k_production_review', family: 'k_production', matter: 'M-1001', category: 'billable', task: 'L320', act: 'A104', minutes: [45, 110],
    summary: "Review Calder Freight's third document production (CAL-0451 to CAL-1290) for bill-of-lading discrepancies.",
    render: reviewWithDoc(P.vance.email, 'Calder production volume 3',
      "Counsel,\n\nPlease find attached Calder Freight Lines' third production, Bates CAL-0451 through CAL-1290, consisting of bills of lading and driver logs.\n\nRegards,\nGrant Vance\nPryor Vance LLP",
      'CAL_PROD_003.pdf', `${F1}Productions/CAL_PROD_003.pdf`),
  },
  {
    key: 'k_dispatch_logs_weak', family: 'k_dispatch', matter: 'M-1001', category: 'billable', task: 'L320', act: 'A104', minutes: [30, 60], signal: 'weak',
    summary: 'Review Kestrel dispatch logs from the Newark terminal collected for production.',
    render: reviewEmailOnly(P.moss.email, 'Dispatch logs from the Newark terminal',
      'Dana,\n\nHere are the dispatch logs from the Newark terminal for March through June 2025. Let me know if you need the driver assignments too.\n\nJanet',
      ['Newark dispatch logs Mar-Jun 2025.xlsx']),
  },
  {
    key: 'k_client_call', family: 'k_moss_call', matter: 'M-1001', category: 'billable', task: 'L320', act: 'A106', minutes: [20, 45],
    summary: 'Telephone conference with J. Moss (Kestrel) regarding custodians for document collection.',
    render: calendarOnly('Call w/ Janet Moss re custodians', [P.moss.email], 'Video call'),
  },
  {
    key: 'k_meet_confer', family: 'k_meet_confer', matter: 'M-1001', category: 'billable', task: 'L310', act: 'A107', minutes: [20, 40],
    summary: "Meet and confer with G. Vance (Pryor Vance) regarding deficiencies in Calder's interrogatory responses.",
    render: calendarOnly('Meet and confer - Calder interrogatory responses', [P.vance.email]),
  },
  {
    key: 'k_depo_scheduling', family: 'k_depo_sched', matter: 'M-1001', category: 'billable', task: 'L330', act: 'A107', minutes: [8, 15],
    summary: "Correspond with G. Vance regarding scheduling of Calder's Rule 30(b)(6) deposition.",
    render: thread(P.vance.email, 'Calder 30(b)(6) dates',
      'Dana,\n\nOur designee is available April 14 or April 16. Please let us know which works and whether you will notice it in person.\n\nGrant',
      'Grant,\n\nApril 16 works for us. We will serve an amended notice this week and plan to proceed in person at your offices.\n\nDana'),
  },
  {
    key: 'k_custodian_internal', family: 'k_custodian', matter: 'M-1001', category: 'billable', task: 'L320', act: 'A105', minutes: [6, 12],
    summary: 'Confer with T. Reyes regarding additions to the custodian list for document collection.',
    render: thread(P.reyes.email, 'custodian list',
      'Dana, should I add the two dispatch supervisors to the custodian list before it goes out tomorrow? -Tom',
      'Yes, add both and flag the warehouse manager as well. Thanks.'),
  },
  {
    key: 'k_expert_damages', family: 'park_k', matter: 'M-1001', category: 'billable', task: 'L130', act: 'A108', minutes: [8, 15],
    summary: 'Correspond with L. Park (Brightline) regarding freight volume data needed for the damages model.',
    render: thread(P.park.email, 'Data request',
      'Dana,\n\nTo finish the damages model I need lane-level freight volumes for 2024 and the rate sheets you mentioned. Can you send them by Wednesday?\n\nLena',
      "Lena,\n\nI've asked the client for the lane-level volumes and rate sheets and will send them as soon as they arrive.\n\nDana"),
  },
  {
    key: 'k_notes_thin', family: 'k_notes', matter: 'M-1001', category: 'billable', task: 'L330', act: 'A101', minutes: [35, 35],
    summary: "Prepare notes for outline of Rule 30(b)(6) deposition of Calder Freight Lines' corporate designee.",
    thin: true, draftNarrative: 'Revise Notes.docx in the Kestrel matter folder.',
    render: docOnly(`${F1}Notes.docx`),
  },
  {
    key: 'k_phone_moss', family: 'k_moss_call', matter: 'M-1001', category: 'billable', task: 'L320', act: 'A106', minutes: [12, 25],
    summary: 'Telephone conference with J. Moss regarding status of dispatch log collection.',
    render: phoneOnly(P.moss.phone, 'in'),
  },
  {
    key: 'k_dup_call', family: 'k_moss_call', matter: 'M-1001', category: 'billable', task: 'L310', act: 'A106', minutes: [43, 43],
    summary: 'Telephone conference with J. Moss regarding draft interrogatory responses.',
    render: (ctx, block, start) => {
      const c = cal(ctx, block, { title: 'Call w/ Janet Moss re interrogatory responses', start, end: start + 30 * MIN, attendees: [P.moss.email, DANA], description: `Dial ${P.moss.phone}` });
      const p = call(ctx, block, { number: P.moss.phone, start: start + MIN, duration: 42 * MIN, direction: 'out' });
      return { end: start + 43 * MIN, trueSeconds: 42 * MIN, ids: [c, p] };
    },
  },
  {
    key: 'k_strategy_partner', family: 'k_strategy', matter: 'M-1001', category: 'billable', task: 'L120', act: 'A105', minutes: [25, 45],
    summary: 'Confer with R. Calloway regarding Kestrel discovery strategy and deposition sequencing.',
    render: calendarOnly('Kestrel/Calder strategy', [P.calloway.email]),
  },

  // ----- M-1002 Halberd Therapeutics v. Ostrander (preliminary injunction) -----
  {
    key: 'h_reply_brief', family: 'h_reply', matter: 'M-1002', category: 'billable', task: 'L220', act: 'A103', minutes: [60, 115],
    summary: "Draft reply brief in support of Halberd's motion for preliminary injunction against Dr. Ostrander.",
    render: docOnly(`${F2}Reply ISO Motion for Preliminary Injunction.docx`),
  },
  {
    key: 'h_reply_brief_long', family: 'h_reply', matter: 'M-1002', category: 'billable', task: 'L220', act: 'A103', minutes: [270, 270],
    summary: "Draft reply brief in support of Halberd's motion for preliminary injunction against Dr. Ostrander.",
    render: docOnly(`${F2}Reply ISO Motion for Preliminary Injunction.docx`),
  },
  {
    key: 'h_chu_declaration', family: 'h_decl', matter: 'M-1002', category: 'billable', task: 'L220', act: 'A103', minutes: [40, 90],
    summary: 'Draft supplemental declaration of L. Chu regarding server access logs.',
    render: docThenSend(`${F2}Supplemental Declaration of L. Chu.docx`, P.chu.email, 'Supplemental declaration for your review',
      'Lauren,\n\nAttached is a draft supplemental declaration describing the server access logs. Please confirm paragraphs 4-9 match what your IT team found.\n\nDana'),
  },
  {
    key: 'h_expedited_motion', family: 'h_expedited', matter: 'M-1002', category: 'billable', task: 'L250', act: 'A103', minutes: [45, 110],
    summary: "Draft motion for expedited discovery of Dr. Ostrander's personal devices.",
    render: docOnly(`${F2}Motion for Expedited Discovery.docx`),
  },
  {
    key: 'h_opposition_review', family: 'h_opposition', matter: 'M-1002', category: 'billable', task: 'L220', act: 'A104', minutes: [40, 100],
    summary: "Review Dr. Ostrander's opposition to Halberd's motion for preliminary injunction.",
    render: reviewWithDoc(P.kessler.email, 'Ostrander - opposition to PI motion',
      "Counsel,\n\nAttached is Dr. Ostrander's opposition to the motion for preliminary injunction, filed this morning, with her supporting declaration.\n\nEvan Kessler\nGray Kessler LLP",
      'Opposition to PI Motion.pdf', `${F2}Opposition to PI Motion.pdf`),
  },
  {
    key: 'h_expert_imaging', family: 'park_h', matter: 'M-1002', category: 'billable', task: 'L110', act: 'A108', minutes: [8, 15],
    summary: "Correspond with L. Park (Brightline) regarding forensic imaging of Dr. Ostrander's laptop.",
    render: thread(P.park.email, 'Imaging timeline',
      'Dana,\n\nWe can image the laptop on Thursday once opposing counsel confirms the chain-of-custody protocol. Can you send me the device inventory?\n\nLena',
      "Lena,\n\nThursday works. I'll send the device inventory today and confirm the protocol with opposing counsel.\n\nDana"),
  },
  {
    key: 'h_report_review', family: 'park_h_report', matter: 'M-1002', category: 'billable', task: 'L110', act: 'A104', minutes: [30, 75],
    summary: "Review Brightline's preliminary forensic imaging report on Dr. Ostrander's laptop.",
    render: reviewWithDoc(P.park.email, 'Preliminary imaging report',
      'Dana,\n\nAttached is our preliminary report. Short version: three USB transfers in the week before her resignation.\n\nLena',
      'Brightline Preliminary Imaging Report.pdf', `${F2}Brightline Preliminary Imaging Report.pdf`),
  },
  {
    key: 'h_client_call', family: 'h_chu_call', matter: 'M-1002', category: 'billable', task: 'L220', act: 'A106', minutes: [20, 40],
    summary: 'Telephone conference with L. Chu (Halberd) regarding supplemental declaration and server access logs.',
    render: calendarOnly('Call w/ Lauren Chu re declaration', [P.chu.email]),
  },
  {
    key: 'h_kessler_call', family: 'h_kessler', matter: 'M-1002', category: 'billable', task: 'L250', act: 'A107', minutes: [15, 30],
    summary: 'Telephone conference with E. Kessler regarding a stipulated schedule for expedited discovery.',
    render: phoneOnly(P.kessler.phone, 'out'),
  },
  {
    key: 'h_hearing', family: 'h_hearing', matter: 'M-1002', category: 'billable', task: 'L220', act: 'A109', minutes: [90, 140],
    summary: "Attend hearing on Halberd's motion for preliminary injunction.",
    render: calendarOnly('Hearing: Halberd v. Ostrander PI motion (Part 12)', [P.chu.email], 'Courtroom 12, in person'),
  },
  {
    key: 'h_access_logs_email', family: 'h_logs', matter: 'M-1002', category: 'billable', task: 'L220', act: 'A106', minutes: [8, 15],
    summary: 'Correspond with L. Chu regarding export of server access logs for the reply brief.',
    render: thread(P.chu.email, 'Access log export',
      'Dana, IT can export the access logs for January through March. Do you want them as CSV or PDF? Lauren',
      'Lauren, CSV is best, with the user IDs included. Thank you. Dana'),
  },

  // ----- M-1003 Ruiz v. Bellhaven Hotel Group (early case assessment and mediation) -----
  {
    key: 'b_eca_memo', family: 'b_eca', matter: 'M-1003', category: 'billable', task: 'L120', act: 'A103', minutes: [60, 130],
    summary: "Draft early case assessment memorandum evaluating Ruiz's wage-and-hour claims.",
    render: docOnly(`${F3}Early Case Assessment - Ruiz.docx`),
  },
  {
    key: 'b_mediation_statement', family: 'b_statement', matter: 'M-1003', category: 'billable', task: 'L160', act: 'A103', minutes: [60, 140],
    summary: 'Draft confidential mediation statement for submission to mediator E. Strand.',
    render: docThenSend(`${F3}Mediation Statement - Bellhaven.docx`, P.strand.email, 'Bellhaven mediation statement',
      "Judge Strand,\n\nAttached is Bellhaven's confidential mediation statement for the April 2 session.\n\nRespectfully,\nDana Whitfield"),
  },
  {
    key: 'b_payroll_review', family: 'b_payroll', matter: 'M-1003', category: 'billable', task: 'L120', act: 'A104', minutes: [40, 90],
    summary: 'Review Ruiz payroll and timekeeping records produced by Bellhaven.',
    render: reviewWithDoc(P.holt.email, 'Ruiz payroll and timekeeping records',
      "Dana,\n\nAttached are Carlos Ruiz's payroll and timekeeping records for 2024 and 2025.\n\nDerek",
      'Ruiz_Payroll_2024-2025.xlsx', `${F3}Ruiz_Payroll_2024-2025.xlsx`),
  },
  {
    key: 'b_eeoc_weak', family: 'b_eeoc', matter: 'M-1003', category: 'billable', task: 'L110', act: 'A104', minutes: [20, 45], signal: 'weak',
    summary: "Review Ruiz's EEOC charge and right-to-sue letter.",
    render: reviewEmailOnly(P.amaro.email, 'Ruiz - EEOC charge',
      "Counsel,\n\nAs discussed, attached are Mr. Ruiz's EEOC charge and right-to-sue letter.\n\nNina Amaro\nAmaro & Lutz PC",
      ['Ruiz EEOC Charge.pdf', 'Right to Sue.pdf']),
  },
  {
    key: 'b_holt_call', family: 'b_holt_call', matter: 'M-1003', category: 'billable', task: 'L120', act: 'A106', minutes: [20, 45],
    summary: "Telephone conference with D. Holt (Bellhaven) regarding Ruiz's shift scheduling records.",
    render: calendarOnly('Call w/ Derek Holt re scheduling records', [P.holt.email]),
  },
  {
    key: 'b_mediator_call', family: 'b_mediator_call', matter: 'M-1003', category: 'billable', task: 'L160', act: 'A108', minutes: [10, 25],
    summary: 'Telephone conference with mediator E. Strand regarding mediation logistics and submissions.',
    render: phoneOnly(P.strand.phone, 'in'),
  },
  {
    key: 'b_demand_email', family: 'b_demand', matter: 'M-1003', category: 'billable', task: 'L160', act: 'A107', minutes: [8, 15],
    summary: "Correspond with N. Amaro regarding plaintiff's settlement demand.",
    render: thread(P.amaro.email, 'Ruiz settlement demand',
      "Dana, ahead of mediation, Mr. Ruiz's demand is $185,000 inclusive of fees. Nina",
      "Nina, received. We'll respond through Judge Strand before the session. Dana"),
  },
  {
    key: 'b_mediation_session', family: 'b_session', matter: 'M-1003', category: 'billable', task: 'L160', act: 'A109', minutes: [180, 225],
    summary: 'Attend mediation session at Strand ADR with D. Holt.',
    render: calendarOnly('Mediation - Ruiz v. Bellhaven (Strand ADR)', [P.strand.email, P.holt.email, P.amaro.email], 'Strand ADR offices, 4th floor'),
  },
  {
    key: 'b_eca_partner', family: 'b_eca_partner', matter: 'M-1003', category: 'billable', task: 'L120', act: 'A105', minutes: [20, 40],
    summary: 'Confer with R. Calloway regarding early case assessment of Ruiz claims.',
    render: calendarOnly('Ruiz ECA review', [P.calloway.email]),
  },

  // ----- firm administration (never billed) -----
  {
    key: 'a_cle', family: 'a_cle', matter: null, category: 'admin', task: '', act: '', minutes: [60, 60],
    summary: 'CLE webinar on ethics in e-discovery (non-billable).',
    render: (ctx, block, start) => {
      const e = email(ctx, block, { direction: 'received', from: P.cle.email, to: [DANA], subject: 'Registration confirmed: CLE Webinar', body: "You're registered for Ethics in E-Discovery (1.0 ethics credit). The link is in your calendar invite.", at: start - int(ctx.r, 90, 240) * MIN, opened: start - 30 * MIN });
      const c = cal(ctx, block, { title: 'CLE Webinar: Ethics in E-Discovery', start, end: start + 60 * MIN, attendees: [DANA] });
      return { end: start + 60 * MIN, trueSeconds: 60 * MIN, ids: [e, c] };
    },
  },
  {
    key: 'a_timesheet', family: 'a_timesheet', matter: null, category: 'admin', task: '', act: '', minutes: [15, 25],
    summary: 'Submit February time entries (non-billable).',
    render: (ctx, block, start, minutes) => {
      const end = start + minutes * MIN;
      const e = email(ctx, block, { direction: 'received', from: P.billing.email, to: [DANA], subject: 'Reminder: submit February time entries', body: 'Please submit all February time entries by Friday so invoices can go out on time.', at: start - int(ctx.r, 30, 300) * MIN, opened: start });
      const d = doc(ctx, block, { path: '/Admin/Time/February time entries.xlsx', start: start + MIN, end });
      return { end, trueSeconds: end - start, ids: [e, d] };
    },
  },
  {
    key: 'a_it_ticket', family: 'a_it', matter: null, category: 'admin', task: '', act: '', minutes: [10, 15],
    summary: 'VPN password reset with IT (non-billable).',
    render: (ctx, block, start, minutes) => {
      const e = email(ctx, block, { direction: 'received', from: P.it.email, to: [DANA], subject: 'Ticket #4471: VPN password reset', body: 'Your VPN password reset request is open. A technician will call you shortly.', at: start - 5 * MIN, opened: start });
      const duration = minutes * MIN;
      const p = call(ctx, block, { number: P.it.phone, start: start + 3 * MIN, duration, direction: 'in' });
      return { end: start + 3 * MIN + duration, trueSeconds: 3 * MIN + duration, ids: [e, p] };
    },
  },
  {
    key: 'a_practice_group', family: 'a_pg', matter: null, category: 'admin', task: '', act: '', minutes: [45, 45],
    summary: 'Litigation practice group meeting (non-billable).',
    render: calendarOnly('Litigation practice group meeting', [P.calloway.email, P.reyes.email]),
  },
  {
    key: 'a_pitch', family: 'a_pitch', matter: null, category: 'admin', task: '', act: '', minutes: [30, 55],
    summary: 'Business development pitch for a prospective client (non-billable).',
    render: (ctx, block, start, minutes) => {
      const end = start + minutes * MIN;
      return { end, trueSeconds: end - start, ids: [doc(ctx, block, { path: '/BD/Pitch - Wrenmoor Foods (prospect).pptx', start, end })] };
    },
  },

  // ----- personal -----
  { key: 'p_dentist', family: 'p_dentist', matter: null, category: 'personal', task: '', act: '', minutes: [60, 60], summary: 'Dentist appointment.', render: calendarOnly('Dentist', []) },
  { key: 'p_lunch', family: 'p_lunch', matter: null, category: 'personal', task: '', act: '', minutes: [40, 50], summary: 'Lunch.', render: calendarOnly('Lunch w/ Sam', []) },
];

const byKey = new Map(T.map((t) => [t.key, t]));
const tpl = (key: string): Template => {
  const t = byKey.get(key);
  if (!t) throw new Error(`Unknown template ${key}`);
  return t;
};

const TRAP_TEMPLATE: Record<Exclude<TrapKind, 'declined'>, string[]> = {
  duplicate_call: ['k_dup_call'],
  shared_expert: ['h_expert_imaging', 'k_expert_damages'],
  internal_email: ['k_custodian_internal'],
  phone_only: ['k_phone_moss', 'h_kessler_call', 'b_mediator_call'],
  admin: ['a_cle', 'a_timesheet', 'a_it_ticket'],
  personal: ['p_dentist'],
  long_block: ['h_reply_brief_long'],
  thin_context: ['k_notes_thin'],
};

const EXPECT: Record<TrapKind, string> = {
  duplicate_call: 'One activity of 42 minutes after reconcile',
  shared_expert: 'Review queue, or matched to the right matter from content',
  internal_email: 'Matched to M-1001 from content, since the firm domain says nothing',
  phone_only: "Matched through the contact's phone number",
  admin: 'Category admin; NON_BILLABLE_ADMIN if it gets drafted',
  personal: 'Excluded as personal',
  declined: 'Excluded',
  long_block: 'LONG_ENTRY flag',
  thin_context: 'VAGUE_NARRATIVE flag; the rewrite asks what the notes were for',
};

// Which traps each day carries (2-4 each). Day 03 is the demo day.
const DAY_TRAPS: { traps: [TrapKind, string?][] }[] = [
  { traps: [['phone_only', 'k_phone_moss'], ['admin', 'a_timesheet'], ['declined']] },
  { traps: [['internal_email'], ['long_block'], ['personal']] },
  { traps: [['duplicate_call'], ['shared_expert', 'h_expert_imaging'], ['admin', 'a_cle'], ['thin_context']] },
  { traps: [['shared_expert', 'k_expert_damages'], ['phone_only', 'h_kessler_call'], ['declined']] },
  { traps: [['long_block'], ['admin', 'a_it_ticket'], ['personal']] },
  { traps: [['duplicate_call'], ['internal_email'], ['admin', 'a_cle']] },
  { traps: [['thin_context'], ['shared_expert', 'h_expert_imaging'], ['declined']] },
  { traps: [['phone_only', 'b_mediator_call'], ['long_block'], ['admin', 'a_timesheet']] },
  { traps: [['duplicate_call'], ['shared_expert', 'k_expert_damages'], ['personal']] },
  { traps: [['internal_email'], ['admin', 'a_it_ticket'], ['thin_context']] },
  { traps: [['long_block'], ['phone_only', 'h_kessler_call'], ['declined'], ['admin', 'a_cle']] },
  { traps: [['duplicate_call'], ['shared_expert', 'h_expert_imaging'], ['internal_email']] },
];

const DAY_START = 8 * 3600 + 30 * MIN;
const DAY_END = 18 * 3600 + 45 * MIN;

interface Planned {
  tpl: Template;
  minutes: number;
  trap?: TrapKind;
}

function planDay(r: Rng, index: number): Planned[] {
  const chosen: Planned[] = [];
  const families = new Set<string>();
  const add = (t: Template, trap?: TrapKind) => {
    families.add(t.family);
    chosen.push({ tpl: t, minutes: int(r, t.minutes[0], t.minutes[1]), trap });
  };
  for (const [kind, key] of DAY_TRAPS[index].traps) {
    if (kind === 'declined') continue; // rendered as noise, not a block
    add(tpl(key ?? TRAP_TEMPLATE[kind][0]), kind);
  }
  // Fill with ordinary billable work until the day looks real: 6-10 billable blocks, about 5.5-8 hours.
  const targetCount = int(r, 6, 10);
  // Each block costs its minutes plus up to 15 minutes of gap and a little overrun; the day has 615 minutes.
  const budget = 595;
  const cost = (minutes: number) => minutes + 18;
  const used = () => chosen.reduce((s, p) => s + cost(p.minutes), 0);
  const billable = () => chosen.filter((p) => p.tpl.category === 'billable').length;
  const pool = shuffle(r, T.filter((t) => t.category === 'billable' && !Object.values(TRAP_TEMPLATE).flat().includes(t.key) && t.key !== 'h_reply_brief_long'));
  for (const t of pool) {
    if (billable() >= targetCount) break;
    if (families.has(t.family)) continue;
    const minutes = int(r, t.minutes[0], t.minutes[1]);
    if (used() + cost(minutes) > budget) continue;
    families.add(t.family);
    chosen.push({ tpl: t, minutes });
  }
  if (r() < 0.6 && !families.has('p_lunch') && used() + cost(50) <= budget) add(tpl('p_lunch'));
  if (r() < 0.3 && !families.has('a_pg') && used() + cost(45) <= budget) add(tpl('a_practice_group'));
  if (r() < 0.2 && !families.has('a_pitch') && used() + cost(55) <= budget) add(tpl('a_pitch'));
  // Lunch goes near the middle of the day; everything else in random order.
  const lunch = chosen.filter((p) => p.tpl.key === 'p_lunch');
  const rest = shuffle(r, chosen.filter((p) => p.tpl.key !== 'p_lunch'));
  rest.splice(Math.floor(rest.length / 2), 0, ...lunch);
  return rest;
}

function buildDay(index: number, seed: number): { fixture: DayFixture; key: AnswerKey } {
  const r = mulberry32(seed + index * 1009);
  const dayNum = pad(index + 1);
  const date = DATES[index];
  const fixture: DayFixture = { day_id: `day-${dayNum}`, date, emails: [], calendar: [], doc_sessions: [], calls: [] };
  const key: AnswerKey = { day_id: fixture.day_id, split: index < 8 ? 'dev' : 'holdout', blocks: [], activities: {}, traps: [] };
  const ctx: Ctx = { date, tag: `d${dayNum}`, r, fx: fixture, key, counters: { e: 0, c: 0, d: 0, p: 0, t: 0 } };

  let cursor = DAY_START + int(r, 0, 20) * MIN;
  let n = 0;
  for (const p of planDay(r, index)) {
    if (cursor + p.minutes * MIN > DAY_END) {
      if (p.trap) throw new Error(`day-${dayNum}: trap ${p.trap} doesn't fit; lower the budget`);
      continue;
    }
    n += 1;
    const blockId = `${fixture.day_id}-b${pad(n)}`;
    const out = p.tpl.render(ctx, blockId, cursor, p.minutes);
    key.blocks.push({
      id: blockId,
      matter_id: p.tpl.matter,
      category: p.tpl.category,
      task_code: p.tpl.task,
      activity_code: p.tpl.act,
      true_seconds: out.trueSeconds,
      signal: p.tpl.signal ?? 'strong',
      summary: p.tpl.summary,
      thin: p.tpl.thin ?? false,
      draft_narrative: p.tpl.draftNarrative ?? p.tpl.summary,
    });
    if (p.trap) key.traps.push({ kind: p.trap, activity_ids: out.ids, expect: EXPECT[p.trap] });
    cursor = out.end + int(r, 5, 15) * MIN;
  }

  // Noise that isn't work: an unread newsletter, and on some days a declined invite.
  if (r() < 0.75) {
    email(ctx, null, { direction: 'received', from: 'digest@lawdigest.example', to: [DANA], subject: 'This week in litigation', body: 'Top stories: appellate roundup, new e-discovery rules, and a profile of the year in trade secret verdicts.', at: int(r, 6, 9) * 3600, opened: null });
  }
  if (DAY_TRAPS[index].traps.some(([k]) => k === 'declined')) {
    const start = int(r, 10, 15) * 3600;
    const id = cal(ctx, null, { title: 'Vendor webinar: AI in legal ops', start, end: start + 45 * MIN, attendees: ['events@legaltechvendor.example', DANA], response: 'declined' });
    key.traps.push({ kind: 'declined', activity_ids: [id], expect: EXPECT.declined });
  }

  const byTime = <T extends { start?: string; at?: string }>(a: T, b: T) => Date.parse(a.start ?? a.at ?? '') - Date.parse(b.start ?? b.at ?? '');
  fixture.emails.sort(byTime);
  fixture.calendar.sort(byTime);
  fixture.doc_sessions.sort(byTime);
  fixture.calls.sort(byTime);
  return { fixture: DayFixtureSchema.parse(fixture), key: AnswerKeySchema.parse(key) };
}

function checkContacts(): void {
  const firm = loadFirm();
  const known = new Set<string>([
    firm.attorney.email,
    ...firm.firm.admin_senders,
    ...firm.firm.admin_phones,
    ...firm.firm.colleagues.map((c) => c.email),
    ...firm.shared_contacts.flatMap((c) => [c.email, c.phone]),
    ...firm.matters.flatMap((m) => m.parties.flatMap((p) => [p.email, p.phone].filter((x): x is string => Boolean(x)))),
  ]);
  for (const c of Object.values(P)) {
    for (const v of Object.values(c)) if (!known.has(v)) throw new Error(`Generator contact ${v} is missing from config/firm.yaml`);
  }
}

function main() {
  const at = process.argv.indexOf('--seed');
  const seed = at === -1 ? 42 : Number(process.argv[at + 1]);
  if (!Number.isInteger(seed)) throw new Error('--seed needs a whole number, such as --seed 42.');
  checkContacts();
  const rows: string[] = [];
  for (let i = 0; i < DATES.length; i++) {
    const { fixture, key } = buildDay(i, seed);
    fs.writeFileSync(path.join('evals', 'days', `${fixture.day_id}.json`), JSON.stringify(fixture, null, 2) + '\n');
    fs.writeFileSync(path.join('evals', 'keys', `${fixture.day_id}.key.json`), JSON.stringify(key, null, 2) + '\n');
    const activities = fixture.emails.length + fixture.calendar.length + fixture.doc_sessions.length + fixture.calls.length;
    const billable = key.blocks.filter((b) => b.category === 'billable');
    const hours = billable.reduce((s, b) => s + b.true_seconds, 0) / 3600;
    rows.push(`${fixture.day_id}  ${fixture.date}  ${key.split.padEnd(7)}  ${String(activities).padStart(3)} activities  ${String(billable.length).padStart(2)} billable blocks  ${hours.toFixed(1).padStart(4)} h  traps: ${key.traps.map((t) => t.kind).join(', ')}`);
  }
  console.log(rows.join('\n'));
}

main();
