import { atom, read, update } from 'claude-code';
import type { Register } from 'claude-code';

import type { MusterOther } from '../types';

// Muster, inside a Claude Code session. Writes ~/.muster/mod/<session>.json for the VS Code extension,
// draws a band of the other sessions that need you, delivers ~/.muster/inbox/<session>/*.txt as soon as
// this session is idle, and logs a one-line TL;DR under long answers. Hooks only touch memory; all file
// work runs on one timer. MUSTER_HOME overrides ~/.muster.

const others = atom({ plugin: 'muster', key: 'others' } as const, [] as MusterOther[]);
const queued = atom({ plugin: 'muster', key: 'queued' } as const, null as string | null);

type Agent = {
  id: string;
  description: string;
  type: string;
  status: string;
  tool: string | null;
  since: number | null;
};
type Task = { id: string; subject: string; status: string };

const STALE_MS = 6 * 3600_000;

export const register: Register = (on) => {
  const st = {
    v: 1,
    sid: '',
    turn: 'idle' as 'idle' | 'running' | 'ended',
    turnStartedAt: null as number | null,
    lastTurnEndedAt: null as number | null,
    lastTurnReason: null as string | null,
    lastTurnError: null as string | null, // first line of the answer when the turn ended on an error
    lastPrompt: '',
    permission: null as { tool: string; detail: string; since: number } | null,
    tool: null as { name: string; since: number } | null,
    context: null as { tokens: number | null; window: number; percent: number | null } | null,
    costUsd: null as number | null,
    agents: [] as Agent[],
    tasks: [] as Task[],
    tldr: null as { text: string; forTurnEndedAt: number } | null,
    updatedAt: 0,
  };
  const agentTool = new Map<string, { tool: string; since: number }>();
  let dirty = true;
  let pendingTldr: { prompt: string; answer: string; endedAt: number } | null = null;
  let lastAnswerEnd = 0;
  let mod = ''; // this session's state file, known once the session started

  on('session.start', async ($, e, next) => {
    const result = await next(e);
    st.sid = await $.session.id();
    const home = (await $.env.get('HOME')) ?? '';
    const muster = (await $.env.get('MUSTER_HOME')) ?? `${home}/.muster`;
    mod = `${muster}/mod/${st.sid}.json`;
    const mine = mod;
    // one file per message, renamed into place by the extension
    const inbox = `${muster}/inbox/${st.sid}`;
    await $.process.run(['/bin/mkdir', '-p', `${muster}/mod`, inbox], { timeoutMs: 3000 });

    let tick = 0;
    let busy = false;
    let seen: Set<string> | null = null;

    const flush = async () => {
      st.updatedAt = await $.clock.now();
      await $.fs.write(mine, JSON.stringify(st));
      dirty = false;
    };

    // A message waiting for this session: delivered at once when idle, shown in the band while busy.
    const deliver = async () => {
      const names = (await $.fs.list(inbox))
        .filter((f) => f.kind === 'file' && f.name.endsWith('.txt') && !f.name.startsWith('.'))
        .map((f) => f.name)
        .sort();
      if (!names.length) {
        if ((await read($, queued)) !== null) {
          await update($, queued, () => null);
        }
        return;
      }
      if (st.turn === 'running') {
        const preview = (await $.fs.read(`${inbox}/${names[0]}`))
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 80);
        await update($, queued, () =>
          preview ? `${preview}${names.length > 1 ? ` (+${names.length - 1})` : ''}` : null,
        );
        return;
      }
      // each message is taken by renaming it first, so the Stop hook and this never deliver it twice
      const bodies: string[] = [];
      for (const name of names) {
        const taken = `${inbox}/${name}.delivering`;
        if (
          (await $.process.run(['/bin/mv', `${inbox}/${name}`, taken], { timeoutMs: 3000 }))
            .exitCode !== 0
        ) {
          continue;
        }
        bodies.push((await $.fs.read(taken)).trim());
        await $.process.run(['/bin/rm', '-f', taken], { timeoutMs: 3000 });
      }
      await update($, queued, () => null);
      const body = bodies.filter(Boolean).join('\n\n');
      if (body) {
        await $.prompt.submit({ text: `Message from the operator via Muster:\n\n${body}` });
      }
    };

    // Other sessions waiting on permission or stopped by an error, from their mod state or the shell hook's.
    const scanOthers = async () => {
      const now = await $.clock.now();
      const names = new Map<string, string>();
      for (const f of await $.fs.list(`${home}/.claude/sessions`)) {
        if (f.kind !== 'file' || !f.name.endsWith('.json')) {
          continue;
        }
        try {
          const p = JSON.parse(await $.fs.read(`${home}/.claude/sessions/${f.name}`)) as {
            sessionId?: string;
            name?: string;
          };
          if (p.sessionId) {
            names.set(p.sessionId, p.name || p.sessionId.slice(0, 8));
          }
        } catch {
          /* being written */
        }
      }
      const found: MusterOther[] = [];
      for (const [sid, name] of names) {
        if (sid === st.sid) {
          continue;
        }
        let kind: MusterOther['kind'] | null = null;
        let detail: string | undefined;
        try {
          const m = JSON.parse(await $.fs.read(`${muster}/mod/${sid}.json`)) as typeof st;
          if (now - m.updatedAt < STALE_MS) {
            kind = m.permission
              ? 'permission'
              : m.turn === 'idle' && m.lastTurnReason === 'error'
                ? 'failed'
                : null;
            if (kind === 'failed' && m.lastTurnError) {
              detail = m.lastTurnError;
            }
          }
        } catch {
          try {
            const [event, secs] = (await $.fs.read(`${muster}/state/${sid}`)).trim().split(' ');
            if (now - Number(secs) * 1000 < STALE_MS) {
              kind =
                event === 'PermissionRequest'
                  ? 'permission'
                  : event === 'StopFailure'
                    ? 'failed'
                    : null;
            }
          } catch {
            /* no state for that session */
          }
        }
        if (kind) {
          found.push(detail ? { sid, name, kind, detail } : { sid, name, kind });
        }
      }
      const keys = new Set(found.map((o) => `${o.sid}:${o.kind}`));
      if (seen) {
        for (const o of found) {
          if (!seen.has(`${o.sid}:${o.kind}`)) {
            $.ui.toast(
              o.kind === 'permission'
                ? `Muster: ${o.name} is waiting for permission`
                : `Muster: ${o.name} stopped${o.detail ? `: ${o.detail}` : ' with an error'}`,
            );
          }
        }
      }
      seen = keys;
      await update($, others, () => found);
    };

    const refreshUsage = async () => {
      const u = await $.session.usage();
      st.context = {
        tokens: u.context.tokens ?? null,
        window: u.context.window,
        percent: u.context.percent ?? null,
      };
      st.costUsd = u.cost?.usd ?? null;
      const now = await $.clock.now();
      st.agents = (await $.agent.list()).map((a) => {
        const t = agentTool.get(a.id);
        return {
          id: a.id,
          description: a.description,
          type: a.type,
          status: a.status,
          tool: t?.tool ?? null,
          since: t?.since ?? now,
        };
      });
      dirty = true;
    };

    const summarize = async (job: { prompt: string; answer: string; endedAt: number }) => {
      const r = await $.model.complete({
        model: 'haiku',
        maxTokens: 80,
        prompt:
          'In one line of at most 16 words, say where this AI coding session stands after the reply below: ' +
          'what it did and what, if anything, it needs from the user next. Plain words, no dashes as punctuation, no quotes.\n\n' +
          `The user asked: ${job.prompt.slice(0, 600)}\n\nThe reply: ${job.answer.slice(-2500)}`,
      });
      if (!r.isAnswered || !r.text.trim()) {
        return;
      }
      const text = r.text
        .trim()
        .replace(/^["']|["']$/g, '')
        .replace(/\s+/g, ' ');
      st.tldr = { text, forTurnEndedAt: job.endedAt };
      dirty = true;
      $.ui.log(`↳ TL;DR: ${text}`);
    };

    $.clock.every(1000, () => {
      if (busy) {
        return;
      }
      busy = true;
      tick += 1;
      void (async () => {
        try {
          if (pendingTldr) {
            const job = pendingTldr;
            pendingTldr = null;
            await summarize(job);
          }
          if (tick % 3 === 0) {
            await deliver();
          }
          if (tick % 3 === 1) {
            await scanOthers();
          }
          if (tick % 15 === 2 || (st.turn === 'running' && tick % 5 === 2)) {
            await refreshUsage();
          }
          if (dirty || tick % 30 === 0) {
            await flush();
          }
        } catch (err) {
          $.ui.log(`muster: ${err instanceof Error ? err.message : String(err)}`, { to: 'debug' });
        } finally {
          busy = false;
        }
      })();
    });
    return result;
  });

  on('turn.start', async ($, e, next) => {
    st.turn = 'running';
    st.turnStartedAt = await $.clock.now();
    st.lastPrompt = e.text;
    st.permission = null;
    dirty = true;
    return next(e);
  });

  on('turn.complete', async ($, e, next) => {
    const result = await next(e);
    if (e.agentId) {
      agentTool.delete(e.agentId);
      dirty = true;
      return result;
    }
    const now = await $.clock.now();
    st.turn = 'idle';
    st.lastTurnEndedAt = now;
    st.lastTurnReason = e.reason;
    st.lastTurnError =
      e.reason === 'error' ? (e.answer.trim().split('\n')[0] ?? '').slice(0, 80) || null : null;
    st.permission = null;
    st.tool = null;
    dirty = true;
    // ponytail: only long answers get a TL;DR, and at most one a minute, so short exchanges cost nothing
    if (e.reason === 'answer' && e.answer.length > 600 && now - lastAnswerEnd > 60_000) {
      pendingTldr = { prompt: st.lastPrompt, answer: e.answer, endedAt: now };
      lastAnswerEnd = now;
    }
    return result;
  });

  on('classic.PermissionRequest', async ($, e, next) => {
    const input = (e.tool_input ?? {}) as Record<string, unknown>;
    const detail = String(
      input.command ?? input.file_path ?? input.url ?? input.description ?? '',
    ).slice(0, 120);
    st.permission = { tool: e.tool_name, detail, since: await $.clock.now() };
    dirty = true;
    return next(e);
  });

  on('tool.call', async ($, e, next) => {
    const who = e.agentId ?? 'main';
    const since = await $.clock.now();
    agentTool.set(who, { tool: e.tool, since });
    if (who === 'main') {
      st.tool = { name: e.tool, since };
    }
    dirty = true;
    try {
      return await next(e);
    } finally {
      // the call has run, so any permission it waited for was answered
      if (st.permission && st.permission.tool === e.tool) {
        st.permission = null;
      }
      if (who === 'main') {
        st.tool = null;
      }
      agentTool.delete(who);
      dirty = true;
    }
  });

  on('classic.TaskCreated', async ($, e, next) => {
    st.tasks = [
      ...st.tasks.filter((t) => t.id !== e.task_id),
      { id: e.task_id, subject: e.task_subject, status: 'pending' },
    ].slice(-40);
    dirty = true;
    return next(e);
  });

  on('classic.TaskCompleted', async ($, e, next) => {
    const t = st.tasks.find((x) => x.id === e.task_id);
    if (t) {
      t.status = 'completed';
    } else {
      st.tasks.push({ id: e.task_id, subject: e.task_subject, status: 'completed' });
    }
    dirty = true;
    return next(e);
  });

  on('session.end', async ($, e, next) => {
    st.turn = 'ended';
    st.updatedAt = await $.clock.now();
    if (mod) {
      await $.fs.write(mod, JSON.stringify(st));
    }
    return next(e);
  });

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, others);
    const q = await read($, queued);
    if (e.props.hasSurvey || (!list.length && !q)) {
      return next(e);
    }
    const { Box, Text } = $.ui.resolve(e);
    const rest = await next(e); // other plugins' bands and the engine's own stay below Muster's
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" flexWrap="wrap">
          {list.slice(0, 4).map((o) => (
            <Text key={`${o.sid}-${o.kind}`} color={o.kind === 'permission' ? 'yellow' : 'red'}>
              {o.kind === 'permission' ? '⚠ ' : '✖ '}
              {o.name}
              {o.kind === 'permission'
                ? ' needs permission  '
                : ` stopped${o.detail ? `: ${o.detail}` : ' on an error'}  `}
            </Text>
          ))}
          {list.length > 4 ? <Text dimColor>+{list.length - 4} more </Text> : null}
          {q ? <Text dimColor>✉ queued for this session: {q}</Text> : null}
        </Box>
        {rest}
      </Box>
    );
  });
};
