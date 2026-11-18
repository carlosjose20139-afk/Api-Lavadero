export interface ModerationCheckResult {
  flagged: boolean;
  matchedTerms: string[];
  reason?: string;
}

export interface ContentModerationService {
  checkText(text: string): ModerationCheckResult;
}

const DEFAULT_OFFENSIVE_TERMS = [
  'gonorrea',
  'hijueputa',
  'malparido',
  'marica',
  'pirobo',
  'carechimba',
  'imbecil',
  'idiota',
  'estupido',
];

export class BasicSpanishModerationService implements ContentModerationService {
  private readonly terms: string[];

  constructor(terms: string[] = DEFAULT_OFFENSIVE_TERMS) {
    this.terms = terms.map((t) => t.toLowerCase());
  }

  checkText(text: string): ModerationCheckResult {
    const normalized = text
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '');

    const matchedTerms = this.terms.filter((term) => {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`\\b${escaped}\\b`, 'i').test(normalized);
    });

    if (matchedTerms.length > 0) {
      return {
        flagged: true,
        matchedTerms,
        reason: 'El contenido contiene lenguaje ofensivo no permitido por las normas del lavadero',
      };
    }

    return {
      flagged: false,
      matchedTerms: [],
    };
  }
}

export const moderationService: ContentModerationService =
  new BasicSpanishModerationService();
