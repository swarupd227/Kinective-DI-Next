// An institution's own words (Core Mapping and Ontology, phase 11). onto_word is an append-only
// ledger: each approved change adds a row ("owners" now means customers; "owners" no longer means
// anything), and the latest row for a word decides. The application account may add rows, never
// change or remove one, and a reseed keeps the institution's rows, as it keeps real AI usage.
type InstitutionType = 'credit_union' | 'bank';

export const WORDS_DDL = [
  `CREATE TABLE IF NOT EXISTS onto_word (
     word_id INT AUTO_INCREMENT PRIMARY KEY,
     term VARCHAR(120) NOT NULL,
     concept_id VARCHAR(80) NULL,
     action VARCHAR(8) NOT NULL,
     at DATETIME(3) NOT NULL,
     by_user VARCHAR(40) NOT NULL,
     by_name VARCHAR(80) NOT NULL,
     approval_id VARCHAR(60) NOT NULL,
     question VARCHAR(500) NULL,
     KEY ix_onto_word_term (term, word_id)
   )`,
];

export const WORDS_APPEND_TABLES = ['onto_word'];

/**
 * Questions DI couldn't read in October, as the demo history has them (source 'demo'), so "Which
 * questions couldn't DI read?" has something to show before anyone has asked one. Each is a kind DI
 * meets: the other institution type's word, a misspelling, and a figure nothing defines.
 */
export function unreadDemo(type: InstitutionType): unknown[][] {
  const asked: [day: string, user: string, question: string][] =
    type === 'bank'
      ? [
          ['2026-10-06 09:14:00', 'user:4410', 'How many owners do we have?'],
          ['2026-10-14 15:02:00', 'user:4410', 'How many owners opened accounts in September?'],
          ['2026-10-20 11:40:00', 'user:9229', 'Show certficates by branch'],
          ['2026-10-23 08:55:00', 'user:4410', 'What is our net promoter score?'],
        ]
      : [
          ['2026-10-07 10:21:00', 'user:9229', 'How many customers do we have?'],
          ['2026-10-13 14:48:00', 'user:4410', 'Show delinquincy by branch'],
          ['2026-10-16 09:05:00', 'user:5120', 'How many customers joined in September?'],
          ['2026-10-21 16:30:00', 'user:9229', 'What were dividends paid last quarter?'],
          ['2026-10-24 13:12:00', 'user:4410', 'What is our net promoter score?'],
        ];
  return asked.map(([at, user, question], i) => [`R-unread-${type === 'bank' ? 'b' : 'c'}${i + 1}`, at, user, `thr_unread${i + 1}`, 'Analytics Q&A', 'data_question', 'demo', question, 'unmatched', null, 0, 0, 0, 0, '[]', 'demo']);
}
