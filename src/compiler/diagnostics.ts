export interface SourceRange { start: number; end: number; line: number; column: number }
export interface CompileDiagnostic { code: string; message: string; range?: SourceRange; hint?: string }
export class CampaignCompileError extends Error {
  constructor(public readonly diagnostics: CompileDiagnostic[]) {
    super(diagnostics.map((item) => `${item.code}: ${item.message}`).join("\n"));
    this.name = "CampaignCompileError";
  }
}
