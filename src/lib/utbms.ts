// UTBMS litigation task codes (leaf level) and activity codes. db/seed/utbms.sql mirrors this list;
// tests/fixtures.test.ts checks they stay identical.

export interface Code {
  code: string;
  phase: string | null;
  label: string;
}

export const TASK_CODES: Code[] = [
  { code: 'L110', phase: 'L100', label: 'Fact Investigation/Development' },
  { code: 'L120', phase: 'L100', label: 'Analysis/Strategy' },
  { code: 'L130', phase: 'L100', label: 'Experts/Consultants' },
  { code: 'L140', phase: 'L100', label: 'Document/File Management' },
  { code: 'L150', phase: 'L100', label: 'Budgeting' },
  { code: 'L160', phase: 'L100', label: 'Settlement/Non-Binding ADR' },
  { code: 'L190', phase: 'L100', label: 'Other Case Assessment, Development and Administration' },
  { code: 'L210', phase: 'L200', label: 'Pleadings' },
  { code: 'L220', phase: 'L200', label: 'Preliminary Injunctions/Provisional Remedies' },
  { code: 'L230', phase: 'L200', label: 'Court Mandated Conferences' },
  { code: 'L240', phase: 'L200', label: 'Dispositive Motions' },
  { code: 'L250', phase: 'L200', label: 'Other Written Motions and Submissions' },
  { code: 'L260', phase: 'L200', label: 'Class Action Certification and Notice' },
  { code: 'L310', phase: 'L300', label: 'Written Discovery' },
  { code: 'L320', phase: 'L300', label: 'Document Production' },
  { code: 'L330', phase: 'L300', label: 'Depositions' },
  { code: 'L340', phase: 'L300', label: 'Expert Discovery' },
  { code: 'L350', phase: 'L300', label: 'Discovery Motions' },
  { code: 'L390', phase: 'L300', label: 'Other Discovery' },
  { code: 'L410', phase: 'L400', label: 'Fact Witnesses' },
  { code: 'L420', phase: 'L400', label: 'Expert Witnesses' },
  { code: 'L430', phase: 'L400', label: 'Written Motions and Submissions' },
  { code: 'L440', phase: 'L400', label: 'Other Trial Preparation and Support' },
  { code: 'L450', phase: 'L400', label: 'Trial and Hearing Attendance' },
  { code: 'L460', phase: 'L400', label: 'Post-Trial Motions and Submissions' },
  { code: 'L470', phase: 'L400', label: 'Enforcement' },
  { code: 'L510', phase: 'L500', label: 'Appellate Motions and Submissions' },
  { code: 'L520', phase: 'L500', label: 'Appellate Briefs' },
  { code: 'L530', phase: 'L500', label: 'Oral Argument' },
];

export const ACTIVITY_CODES: Code[] = [
  { code: 'A101', phase: null, label: 'Plan and prepare for' },
  { code: 'A102', phase: null, label: 'Research' },
  { code: 'A103', phase: null, label: 'Draft/revise' },
  { code: 'A104', phase: null, label: 'Review/analyze' },
  { code: 'A105', phase: null, label: 'Communicate (in firm)' },
  { code: 'A106', phase: null, label: 'Communicate (with client)' },
  { code: 'A107', phase: null, label: 'Communicate (other outside counsel)' },
  { code: 'A108', phase: null, label: 'Communicate (other external)' },
  { code: 'A109', phase: null, label: 'Appear for/attend' },
  { code: 'A110', phase: null, label: 'Manage data/files' },
  { code: 'A111', phase: null, label: 'Other' },
];

export const TASK_CODE_IDS = TASK_CODES.map((c) => c.code);
export const ACTIVITY_CODE_IDS = ACTIVITY_CODES.map((c) => c.code);
export const COMM_ACTIVITY_CODES = ['A105', 'A106', 'A107', 'A108'];

const labels = new Map([...TASK_CODES, ...ACTIVITY_CODES].map((c) => [c.code, c.label]));

export function codeLabel(code: string): string {
  return labels.get(code) ?? code;
}

export function isTaskCode(code: string): boolean {
  return TASK_CODE_IDS.includes(code);
}

export function isActivityCode(code: string): boolean {
  return ACTIVITY_CODE_IDS.includes(code);
}

/** Structured outputs don't guarantee enum casing, so codes are compared case-insensitively. */
export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}
