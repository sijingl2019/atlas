//! Knowledge finder: Ctrl/Cmd+F searches note titles, Ctrl/Cmd+Alt+F runs
//! semantic recall through the local embedding index. A floating bar pinned to
//! the top of the editor column; Esc / click-away closes, up/down + Enter
//! navigate, click opens a result.

import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Loader2, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Hint } from "@/ui/tooltip";

export type FinderMode = "title" | "semantic";

interface FinderEntry {
  id: string;
  title: string;
  icon?: string | null;
}

interface Result {
  id: string;
  title: string;
  icon: string;
  snippet?: string;
  source?: string;
}

interface RecallHit {
  entryId: string;
  title: string;
  snippet: string;
  source: string;
  score: number;
}

const MAX_RESULTS = 50;
const SEMANTIC_DEBOUNCE_MS = 250;

export function KnowledgeFinder({
  entries,
  mode,
  kbRoot,
  onSelect,
  onClose,
}: {
  entries: FinderEntry[];
  mode: FinderMode;
  kbRoot: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState<RecallHit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const iconById = useMemo(() => {
    const map = new Map<string, string>();
    for (const e of entries) map.set(e.id, e.icon || "📄");
    return map;
  }, [entries]);

  useEffect(() => {
    if (mode !== "semantic") {
      requestRef.current += 1;
      setHits([]);
      setError(null);
      setLoading(false);
      return;
    }
    const s = q.trim();
    if (s.length < 2) {
      requestRef.current += 1;
      setHits([]);
      setError(null);
      setLoading(false);
      return;
    }

    const request = ++requestRef.current;
    setLoading(true);
    setError(null);
    const timer = setTimeout(() => {
      invoke<RecallHit[]>("knowledge_recall", {
        projectPath: kbRoot,
        query: s,
        limit: MAX_RESULTS,
      })
        .then((next) => {
          if (requestRef.current !== request) return;
          setHits(next);
          setLoading(false);
        })
        .catch((err) => {
          if (requestRef.current !== request) return;
          setHits([]);
          setError(String(err));
          setLoading(false);
        });
    }, SEMANTIC_DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      if (requestRef.current === request) requestRef.current += 1;
    };
  }, [q, mode, kbRoot]);

  const results = useMemo<Result[]>(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];

    if (mode === "title") {
      const out: Result[] = [];
      for (const e of entries) {
        if (!e.title.toLowerCase().includes(s)) continue;
        out.push({ id: e.id, title: e.title || "Untitled", icon: e.icon || "📄" });
        if (out.length >= MAX_RESULTS) break;
      }
      return out;
    }

    if (s.length < 2) return [];

    return hits.map((h) => ({
      id: h.entryId,
      title: h.title || "Untitled",
      icon: iconById.get(h.entryId) ?? "📄",
      snippet: h.snippet,
      source: h.source,
    }));
  }, [q, mode, entries, hits, iconById]);

  useEffect(() => {
    setActive(0);
  }, [q, mode]);

  const choose = (i: number) => {
    const r = results[i];
    if (r) {
      onSelect(r.id);
      onClose();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, Math.max(results.length - 1, 0)));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(active);
    }
  };

  const modelMissing = error?.includes("model_not_downloaded") ?? false;
  const errorText = modelMissing
    ? "Local embedding model not downloaded. Open Settings > Local models to download it."
    : error;
  const hasQuery = q.trim().length > 0;

  return (
    <div className="absolute left-1/2 top-3 z-popover w-[460px] max-w-[90%] -translate-x-1/2">
      <div className="overflow-hidden rounded-lg border border-border bg-card shadow-md">
        <div className="flex items-center gap-2 px-3 h-9 border-b border-border-subtle">
          <Search size={13} className="shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              mode === "semantic" ? "Semantic search (local model)..." : "Find notes by title..."
            }
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-muted-foreground"
          />
          {loading && <Loader2 size={12} className="shrink-0 animate-spin text-muted-foreground" />}
          {hasQuery && !loading && (
            <span className="shrink-0 text-2xs tabular-nums text-muted-foreground">
              {results.length}
              {results.length >= MAX_RESULTS ? "+" : ""}
            </span>
          )}
          <Hint label="Close" shortcut="Esc">
            <button
              onClick={onClose}
              className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-element-hover cursor-pointer"
            >
              <X size={12} />
            </button>
          </Hint>
        </div>
        {hasQuery && (
          <div className="max-h-[340px] overflow-y-auto hide-scrollbar py-1">
            {errorText ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">{errorText}</div>
            ) : results.length === 0 && !loading ? (
              <div className="px-3 py-3 text-sm text-muted-foreground">No matches</div>
            ) : (
              results.map((r, i) => (
                <button
                  key={r.id}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(i)}
                  className={cn(
                    "flex w-full items-start gap-2 px-3 py-1.5 text-left transition-colors",
                    i === active ? "bg-element-hover" : "hover:bg-element-hover/60",
                  )}
                >
                  <span className="shrink-0 text-base leading-none">{r.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {r.title}
                    </span>
                    {mode === "semantic" && r.snippet && (
                      <span className="mt-0.5 block line-clamp-2 text-xs leading-snug text-muted-foreground">
                        {r.snippet}
                      </span>
                    )}
                    {mode === "semantic" && r.source && (
                      <span className="mt-0.5 block truncate text-2xs text-disabled">
                        {r.source.split(/[\\/]/).pop()}
                      </span>
                    )}
                  </span>
                </button>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}
