export type MusterOther = {
  sid: string;
  name: string;
  kind: 'permission' | 'failed';
  detail?: string;
};

declare module 'claude-code' {
  interface PluginState {
    muster: { others: MusterOther[]; queued: string | null };
  }
}
