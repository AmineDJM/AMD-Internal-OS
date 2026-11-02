"use client";

import * as React from "react";
import { Check, Mail, Phone, MessageCircle, Plus, X, ShieldCheck, Pencil } from "lucide-react";
import {
  ensureDirectoryEntry, addDirectoryEndpoint, deactivateDirectoryEndpoint, updateDirectoryEndpoint, updateDirectoryEntry,
} from "@/lib/actions/directory-actions";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";

/**
 * L'ANNUAIRE DES PERSONNES — l'écran où l'on enrichit ce qu'Adam saura.
 *
 * CE QUE CET ÉCRAN N'EST PAS. Ce n'est pas une seconde fiche salarié : le nom, le poste et le
 * département restent aux RH, et cet écran ne les modifie pas. Il porte ce qu'aucune fiche ne
 * porte — les adresses en plus, le WhatsApp, les alias par lesquels on désigne réellement les gens
 * (« Amine », « AD »), le lieu, des notes — et la PROVENANCE de chaque coordonnée. Tout s'y AJOUTE,
 * s'y MODIFIE et s'y RETIRE (Direction, 06/10).
 *
 * Pourquoi la provenance a sa place à l'écran : c'est elle qui décide, plus tard, sur quelle
 * boîte part un message signé du PDG. La montrer, c'est permettre de la corriger.
 */

import type { DirectoryPerson } from "@/lib/annuaires/types";

export type { DirectoryPerson };

const CONFIDENCE_LABEL: Record<string, string> = {
  VERIFIED_INTERNAL: "vérifiée",
  VERIFIED_PROVIDER: "fiche ERP",
  OBSERVED_HISTORY: "vue en correspondance",
  INFERRED: "à confirmer",
};

const CHANNEL_ICON = {
  EMAIL: Mail,
  PHONE: Phone,
  WHATSAPP: MessageCircle,
} as const;

const champ = "h-10 max-w-full rounded-lg border border-border bg-background px-2 text-sm sm:h-8";

export function PeopleDirectory({ people, canEdit }: { people: DirectoryPerson[]; canEdit: boolean }) {
  const confirmer = useConfirmer();
  const { enCours, rafraichir } = useRafraichir();
  const [query, setQuery] = React.useState("");
  const [openKey, setOpenKey] = React.useState<string | null>(null);
  const [editId, setEditId] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [erreur, setErreur] = React.useState<string | null>(null);
  const occupe = busy || enCours;

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return people;
    return people.filter((p) =>
      p.name.toLowerCase().includes(q)
      || p.aliases.some((a) => a.includes(q))
      || p.endpoints.some((e) => e.value.includes(q))
      || p.erpEmails.some((e) => e.includes(q))
      || (p.location ?? "").toLowerCase().includes(q));
  }, [people, query]);

  /** L'entrée d'annuaire de la personne — créée à la volée, accrochée à sa fiche canonique, jamais en doublon flottant. */
  async function entreeDe(person: DirectoryPerson): Promise<string | null> {
    if (person.entryId) return person.entryId;
    const seed = new FormData();
    if (person.userId) seed.set("userId", person.userId);
    if (person.employeeId) seed.set("employeeId", person.employeeId);
    seed.set("displayName", person.name);
    const created = await ensureDirectoryEntry(seed);
    if (!created.ok || !created.id) { setErreur(created.error ?? "Création impossible."); return null; }
    return created.id;
  }

  async function agir(f: () => Promise<{ ok: boolean; error?: string } | null>, apres?: () => void) {
    if (occupe) return;
    setBusy(true); setErreur(null);
    try {
      const r = await f();
      if (!r) return;
      if (!r.ok) { setErreur(r.error ?? "Enregistrement impossible."); return; }
      apres?.();
      rafraichir();
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-base font-semibold">Personnes &amp; coordonnées</h2>
          <p className="text-xs text-muted-foreground">
            Ce que l&apos;assistant utilise pour joindre quelqu&apos;un. Le nom et le poste restent tenus par les RH.
          </p>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Chercher un nom, un alias, une adresse…"
          className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm sm:w-72"
        />
      </div>
      {erreur && <p role="alert" className="text-sm text-destructive">{erreur}</p>}

      {visible.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">
          {query ? `Personne ne correspond à « ${query} ».` : "Aucune personne dans le registre."}
        </p>
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {visible.map((p) => {
            const open = openKey === p.key;
            const known = p.endpoints.filter((e) => e.channel === "EMAIL").length + p.erpEmails.length;
            return (
              <div key={p.key}>
                <button
                  type="button"
                  onClick={() => { setOpenKey(open ? null : p.key); setEditId(null); setErreur(null); }}
                  className="flex w-full items-start justify-between gap-3 p-3 text-left hover:bg-secondary/40"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">{p.name}</span>
                    <span className="block truncate text-xs text-muted-foreground">
                      {[p.jobTitle, p.department, p.company, p.location].filter(Boolean).join(" · ") || "—"}
                    </span>
                    {p.aliases.length > 0 && (
                      <span className="mt-0.5 block text-[0.6875rem] text-muted-foreground">
                        aussi appelé·e : {p.aliases.join(", ")}
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {known === 0 ? "aucune adresse" : `${known} adresse${known > 1 ? "s" : ""}`}
                  </span>
                </button>

                {open && (
                  <div className="space-y-3 border-t border-border bg-secondary/20 p-3">
                    <ul className="space-y-1.5">
                      {p.endpoints.map((e) => {
                        const Icon = CHANNEL_ICON[e.channel];
                        if (editId === e.id && canEdit) {
                          return (
                            <li key={e.id}>
                              <form
                                className="flex flex-wrap items-end gap-2"
                                onSubmit={(ev) => {
                                  ev.preventDefault();
                                  const fd = new FormData(ev.currentTarget); fd.set("id", e.id);
                                  void agir(() => updateDirectoryEndpoint(fd), () => setEditId(null));
                                }}
                              >
                                <Icon className="mb-2 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                <input name="value" required defaultValue={e.value} aria-label="Valeur" className={`${champ} min-w-[12rem] flex-1`} />
                                <input name="label" defaultValue={e.label ?? ""} placeholder="Usage" aria-label="Usage" className={`${champ} w-32`} />
                                <select name="confidence" defaultValue={e.confidence} aria-label="Fiabilité" className={champ}>
                                  <option value="VERIFIED_INTERNAL">Vérifiée</option>
                                  <option value="OBSERVED_HISTORY">Vue quelque part</option>
                                  <option value="INFERRED">À confirmer</option>
                                  {e.confidence === "VERIFIED_PROVIDER" && <option value="VERIFIED_PROVIDER">Fiche ERP</option>}
                                </select>
                                <label className="flex items-center gap-1.5 text-xs"><input type="checkbox" name="isPrimary" defaultChecked={e.isPrimary} className="h-4 w-4 accent-success" /> Principale</label>
                                <button type="submit" disabled={occupe} className="inline-flex h-10 items-center gap-1 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:h-8"><Check className="h-3.5 w-3.5" /> Enregistrer</button>
                                <button type="button" onClick={() => setEditId(null)} className="h-10 rounded-lg px-3 text-sm text-muted-foreground hover:bg-secondary sm:h-8 sm:px-2">Annuler</button>
                              </form>
                            </li>
                          );
                        }
                        return (
                          <li key={e.id} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="min-w-0 truncate">{e.value}</span>
                            {e.label && <span className="text-xs text-muted-foreground">({e.label})</span>}
                            {e.isPrimary && (
                              <span className="inline-flex items-center gap-0.5 rounded bg-success/15 px-1.5 py-0.5 text-[0.6875rem] text-success">
                                <Check className="h-3 w-3" /> principale
                              </span>
                            )}
                            <span className="inline-flex items-center gap-0.5 rounded bg-secondary px-1.5 py-0.5 text-[0.6875rem] text-muted-foreground">
                              {e.confidence === "VERIFIED_INTERNAL" && <ShieldCheck className="h-3 w-3" />}
                              {CONFIDENCE_LABEL[e.confidence] ?? e.confidence}
                            </span>
                            {canEdit && (
                              <span className="ml-auto flex shrink-0 items-center gap-1">
                                <button type="button" aria-label={`Modifier ${e.value}`} disabled={occupe} onClick={() => setEditId(e.id)}
                                  className="rounded p-2 text-muted-foreground hover:bg-secondary hover:text-foreground sm:p-1">
                                  <Pencil className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button" aria-label={`Retirer ${e.value}`} disabled={occupe}
                                  onClick={async () => {
                                    if (!(await confirmer(`Retirer ${e.value} de l'annuaire ?`))) return;
                                    const fd = new FormData(); fd.set("id", e.id);
                                    void agir(() => deactivateDirectoryEndpoint(fd));
                                  }}
                                  className="rounded p-2 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1"
                                >
                                  <X className="h-3.5 w-3.5" />
                                </button>
                              </span>
                            )}
                          </li>
                        );
                      })}
                      {p.erpEmails.map((mail) => (
                        <li key={mail} className="flex items-center gap-2 text-sm text-muted-foreground">
                          <Mail className="h-3.5 w-3.5 shrink-0" />
                          <span className="min-w-0 truncate">{mail}</span>
                          <span className="rounded bg-secondary px-1.5 py-0.5 text-[0.6875rem]">fiche ERP</span>
                        </li>
                      ))}
                      {p.endpoints.length === 0 && p.erpEmails.length === 0 && (
                        <li className="text-sm text-muted-foreground">Aucune coordonnée connue.</li>
                      )}
                    </ul>

                    {canEdit && (
                      <form
                        onSubmit={(ev) => {
                          ev.preventDefault();
                          const form = ev.currentTarget;
                          const fd = new FormData(form);
                          void agir(async () => {
                            const entryId = await entreeDe(p);
                            if (!entryId) return null;
                            fd.set("entryId", entryId);
                            return addDirectoryEndpoint(fd);
                          }, () => form.reset());
                        }}
                        className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
                      >
                        <label className="text-xs">
                          <span className="mb-0.5 block text-muted-foreground">Canal</span>
                          <select name="channel" className={champ}>
                            <option value="EMAIL">E-mail</option>
                            <option value="PHONE">Téléphone</option>
                            <option value="WHATSAPP">WhatsApp</option>
                          </select>
                        </label>
                        <label className="min-w-[12rem] flex-1 text-xs">
                          <span className="mb-0.5 block text-muted-foreground">Valeur</span>
                          <input name="value" required placeholder="prenom.nom@societe.dz" className={`${champ} w-full`} />
                        </label>
                        <label className="text-xs">
                          <span className="mb-0.5 block text-muted-foreground">Usage</span>
                          <input name="label" placeholder="Pharmagene, perso…" className={`${champ} w-32`} />
                        </label>
                        <label className="text-xs">
                          <span className="mb-0.5 block text-muted-foreground">Fiabilité</span>
                          <select name="confidence" className={champ}>
                            <option value="VERIFIED_INTERNAL">Vérifiée</option>
                            <option value="OBSERVED_HISTORY">Vue quelque part</option>
                            <option value="INFERRED">À confirmer</option>
                          </select>
                        </label>
                        <label className="flex items-center gap-1.5 text-xs">
                          <input type="checkbox" name="isPrimary" className="h-4 w-4 accent-success" />
                          Principale
                        </label>
                        <button
                          type="submit" disabled={occupe}
                          className="inline-flex h-10 w-full items-center justify-center gap-1 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:h-8 sm:w-auto"
                        >
                          <Plus className="h-3.5 w-3.5" /> Ajouter
                        </button>
                      </form>
                    )}

                    {canEdit && <InfosPersonne person={p} occupe={occupe} onSave={(fd) => agir(async () => {
                      const entryId = await entreeDe(p);
                      if (!entryId) return null;
                      fd.set("id", entryId);
                      return updateDirectoryEntry(fd);
                    })} />}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Les informations que l'annuaire porte en propre — alias, lieu, notes. Vider un champ le retire. */
function InfosPersonne({ person, occupe, onSave }: { person: DirectoryPerson; occupe: boolean; onSave: (fd: FormData) => Promise<void> }) {
  const [aliases, setAliases] = React.useState(person.aliases.join(", "));
  const [location, setLocation] = React.useState(person.location ?? "");
  const [notes, setNotes] = React.useState(person.notes ?? "");
  const change = aliases !== person.aliases.join(", ") || location !== (person.location ?? "") || notes !== (person.notes ?? "");
  return (
    <form
      className="flex flex-wrap items-end gap-2 border-t border-border pt-3"
      onSubmit={(ev) => {
        ev.preventDefault();
        const fd = new FormData();
        fd.set("aliases", aliases); fd.set("location", location); fd.set("notes", notes);
        // Le poste affiché reste celui des RH : on le renvoie tel quel pour ne pas l'effacer.
        if (person.jobTitle) fd.set("jobTitle", person.jobTitle);
        void onSave(fd);
      }}
    >
      <label className="min-w-[10rem] flex-1 text-xs">
        <span className="mb-0.5 block text-muted-foreground">Alias (séparés par des virgules)</span>
        <input value={aliases} onChange={(e) => setAliases(e.target.value)} placeholder="amine, ad" className={`${champ} w-full`} />
      </label>
      <label className="text-xs">
        <span className="mb-0.5 block text-muted-foreground">Lieu</span>
        <input value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Siège, Oran…" className={`${champ} w-36`} />
      </label>
      <label className="min-w-[12rem] flex-1 text-xs">
        <span className="mb-0.5 block text-muted-foreground">Notes</span>
        <input value={notes} onChange={(e) => setNotes(e.target.value)} className={`${champ} w-full`} />
      </label>
      {change && (
        <button type="submit" disabled={occupe} className="inline-flex h-10 w-full items-center justify-center gap-1 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground disabled:opacity-50 sm:h-8 sm:w-auto">
          <Check className="h-3.5 w-3.5" /> Enregistrer les infos
        </button>
      )}
    </form>
  );
}
