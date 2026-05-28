import { useEffect, useState } from "react";
import {
  deleteProviderKey,
  getModelCatalog,
  getPreferences,
  listProviderConfigs,
  setPreferences,
  setProviderKey,
} from "../lib/api";
import type {
  ModelCatalog,
  ProviderConfigSummary,
  ProviderId,
  UserPreferences,
} from "../../../shared/types";
import {
  buttonStyle,
  errBox,
  ghostButtonStyle,
  muted,
  sectionTitle,
  textareaStyle,
} from "../styles";

const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
};

export function SettingsView({
  userId,
  onPreferencesChange,
}: {
  userId: string;
  onPreferencesChange?: (prefs: UserPreferences) => void;
}) {
  const [configs, setConfigs] = useState<ProviderConfigSummary[] | null>(null);
  const [prefs, setPrefs] = useState<UserPreferences | null>(null);
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<ProviderId | null>(null);

  useEffect(() => {
    Promise.all([
      listProviderConfigs(userId),
      getPreferences(userId),
      getModelCatalog(),
    ])
      .then(([c, p, cat]) => {
        setConfigs(c);
        setPrefs(p);
        setCatalog(cat);
      })
      .catch((e) => setError(String(e)));
  }, [userId]);

  const refreshConfigs = async () => {
    setConfigs(await listProviderConfigs(userId));
  };

  const handleSaveKey = async (provider: ProviderId, key: string) => {
    await setProviderKey(userId, provider, key);
    setEditing(null);
    await refreshConfigs();
  };

  const handleDeleteKey = async (provider: ProviderId) => {
    await deleteProviderKey(userId, provider);
    await refreshConfigs();
  };

  const handleSetDefault = async (next: UserPreferences) => {
    const updated = await setPreferences(userId, next);
    setPrefs(updated);
    onPreferencesChange?.(updated);
  };

  return (
    <div style={panel}>
      <div style={{ display: "grid", gap: "0.25rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.25rem" }}>Settings</h1>
        <div style={muted}>Local-only, stored in this app's database.</div>
      </div>

      {error && <div style={errBox}>{error}</div>}

      <section style={{ display: "grid", gap: "0.75rem" }}>
        <h2 style={sectionTitle}>API Keys</h2>
        {configs === null ? (
          <div style={muted}>Loading…</div>
        ) : (
          <div style={{ display: "grid", gap: "0.5rem" }}>
            {configs.map((c) => (
              <ProviderRow
                key={c.provider}
                config={c}
                editing={editing === c.provider}
                onStartEdit={() => setEditing(c.provider)}
                onCancelEdit={() => setEditing(null)}
                onSave={(key) => handleSaveKey(c.provider, key)}
                onDelete={() => handleDeleteKey(c.provider)}
              />
            ))}
          </div>
        )}
      </section>

      <section style={{ display: "grid", gap: "0.75rem" }}>
        <h2 style={sectionTitle}>Default model</h2>
        {prefs === null || catalog === null ? (
          <div style={muted}>Loading…</div>
        ) : (
          <DefaultModelPicker
            prefs={prefs}
            catalog={catalog}
            onChange={handleSetDefault}
          />
        )}
        <div style={muted}>
          Used when creating new canvases. Per-canvas or per-node overrides
          would be a future-features item.
        </div>
      </section>
    </div>
  );
}

function ProviderRow({
  config,
  editing,
  onStartEdit,
  onCancelEdit,
  onSave,
  onDelete,
}: {
  config: ProviderConfigSummary;
  editing: boolean;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSave: (key: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (editing) {
      setDraft("");
      setErr(null);
    }
  }, [editing]);

  const isOpenAi = config.provider === "openai";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onSave(draft);
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onDelete();
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <form onSubmit={submit} style={providerRow}>
        <div style={providerLabel}>{PROVIDER_LABEL[config.provider]}</div>
        <input
          type="password"
          autoComplete="off"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={
            config.provider === "anthropic"
              ? "sk-ant-…"
              : config.provider === "openai"
                ? "sk-…"
                : "API key"
          }
          style={inputStyle}
        />
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <button
            type="button"
            onClick={onCancelEdit}
            style={ghostButtonStyle}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !draft.trim()}
            style={buttonStyle}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
        {err && <div style={errBox}>{err}</div>}
      </form>
    );
  }

  return (
    <div style={providerRow}>
      <div style={providerLabel}>{PROVIDER_LABEL[config.provider]}</div>
      <div style={providerValue}>
        {config.hasKey ? (
          <code style={maskedKey}>{config.masked}</code>
        ) : (
          <span style={muted}>
            {isOpenAi ? "Not yet supported by the app" : "No key set"}
          </span>
        )}
      </div>
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={onStartEdit}
          style={ghostButtonStyle}
          disabled={isOpenAi}
        >
          {config.hasKey ? "Replace" : "Add key"}
        </button>
        {config.hasKey && (
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            style={{ ...ghostButtonStyle, color: "crimson" }}
          >
            Remove
          </button>
        )}
      </div>
      {err && <div style={errBox}>{err}</div>}
    </div>
  );
}

function DefaultModelPicker({
  prefs,
  catalog,
  onChange,
}: {
  prefs: UserPreferences;
  catalog: ModelCatalog;
  onChange: (next: UserPreferences) => Promise<void>;
}) {
  const providers = (Object.keys(catalog) as ProviderId[]).filter(
    (p) => catalog[p].length > 0,
  );

  const onProviderChange = (provider: ProviderId) => {
    const firstModel = catalog[provider][0];
    if (!firstModel) return;
    onChange({ defaultProvider: provider, defaultModel: firstModel.id });
  };

  const onModelChange = (model: string) => {
    onChange({ defaultProvider: prefs.defaultProvider, defaultModel: model });
  };

  return (
    <div style={{ display: "grid", gap: "0.5rem" }}>
      <label style={fieldLabel}>
        Provider
        <select
          value={prefs.defaultProvider}
          onChange={(e) => onProviderChange(e.target.value as ProviderId)}
          style={selectStyle}
        >
          {providers.map((p) => (
            <option key={p} value={p}>
              {PROVIDER_LABEL[p]}
            </option>
          ))}
        </select>
      </label>
      <label style={fieldLabel}>
        Model
        <select
          value={prefs.defaultModel}
          onChange={(e) => onModelChange(e.target.value)}
          style={selectStyle}
        >
          {(catalog[prefs.defaultProvider] ?? []).map((m) => (
            <option key={m.id} value={m.id}>
              {m.displayName}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// ---- styles ----

const panel = {
  display: "grid",
  gap: "1.5rem",
  padding:
    "1.25rem max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left))",
  overflowY: "auto" as const,
  alignContent: "start" as const,
  width: "100%",
  height: "100%",
  boxSizing: "border-box" as const,
};

const providerRow = {
  display: "grid",
  gap: "0.5rem",
  padding: "0.75rem 0.85rem",
  border: "1px solid color-mix(in srgb, CanvasText 14%, Canvas)",
  borderRadius: 8,
  background: "color-mix(in srgb, CanvasText 2%, Canvas)",
};

const providerLabel = {
  fontWeight: 600,
  fontSize: "0.95rem",
};

const providerValue = {
  fontSize: "0.9rem",
  overflow: "hidden",
  textOverflow: "ellipsis",
};

const maskedKey = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "0.85rem",
  padding: "0.2rem 0.4rem",
  borderRadius: 4,
  background: "color-mix(in srgb, CanvasText 8%, Canvas)",
};

const inputStyle = {
  ...textareaStyle,
  minHeight: 44,
  resize: "none" as const,
};

const fieldLabel = {
  display: "grid",
  gap: "0.25rem",
  fontSize: "0.85rem",
  color: "color-mix(in srgb, CanvasText 75%, Canvas)",
};

const selectStyle = {
  font: "inherit",
  padding: "0.6rem 0.7rem",
  borderRadius: 8,
  border: "1px solid color-mix(in srgb, CanvasText 20%, Canvas)",
  background: "Canvas",
  color: "CanvasText",
  minHeight: 44,
};
