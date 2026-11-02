"use client";

import * as React from "react";
import { useAction } from "@/components/shared/use-action";
import { Copy, Check, Pencil, Loader2, ClipboardList, Paperclip } from "lucide-react";
import { saveCompanyIdentity } from "@/lib/actions/company-identity-actions";
import { identityBlock, filledCount, type IdentitySection } from "@/lib/legal/identity";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Textarea } from "@/components/ui/input";
import { DocumentUpload } from "@/components/documents/document-upload";
import { DocumentList, type DocItem } from "@/components/documents/document-list";
import { COMPANY_DOC_CATEGORIES } from "@/lib/legal/company-docs";
import { cn } from "@/lib/utils";

export interface IdentityCompany {
  id: string;
  label: string;
  color: string | null;
  values: Record<string, string>;
  /** Les pièces déjà déposées sur CETTE entité — statuts, extrait du RC, attestation, RIB scanné. */
  documents: DocItem[];
}

/**
 * LA CARTE D'IDENTITÉ D'UNE ENTITÉ — on choisit la société, on lit, on copie.
 *
 * Le geste que cet écran remplace : ouvrir un vieux document Word, chercher le NIF au milieu
 * d'une page, le retaper à la main dans un appel d'offres. Chaque champ se copie donc SEUL, et
 * la carte entière se copie d'un bloc — c'est ce qu'on colle dans un dossier.
 *
 * Le retour visuel dure une seconde : sans lui, on ne sait pas si le clic a pris, et l'on colle
 * l'ancien contenu du presse-papier dans un document officiel.
 */
export function IdentityBoard({
  companies, sections, initial, canEdit,
}: {
  companies: IdentityCompany[];
  sections: IdentitySection[];
  initial: string;
  canEdit: boolean;
}) {
  const [companyId, setCompanyId] = React.useState(initial);
  const [editing, setEditing] = React.useState(false);
  const company = companies.find((c) => c.id === companyId) ?? companies[0];
  const count = filledCount(company.values);

  return (
    <div className="space-y-4">
      {/* Le choix de l'entité — des pastilles plutôt qu'un menu : on bascule entre deux ou
          trois sociétés en boucle, et un menu déroulant demande deux clics à chaque fois. */}
      <div className="flex flex-wrap items-center gap-2">
        {companies.map((c) => (
          <button
            key={c.id} type="button" onClick={() => setCompanyId(c.id)}
            className={cn(
              "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              c.id === company.id ? "border-primary bg-primary/10 text-primary" : "border-border hover:bg-secondary",
            )}
          >
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: c.color ?? "#94a3b8" }} />
            {c.label}
          </button>
        ))}
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <CopyButton
            value={identityBlock(company.values)} label="Copier la carte"
            title="Copier tous les champs renseignés, en bloc"
          />
          {canEdit && (
            <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-4 w-4" /> Renseigner
            </Button>
          )}
        </span>
      </div>

      {count.filled === 0 ? (
        <p className="rounded-xl border border-warning/40 bg-warning/5 p-4 text-sm text-muted-foreground">
          <strong>Carte vide pour {company.label}.</strong> Rien n&apos;est deviné ici : un numéro
          fiscal ne s&apos;invente pas. {canEdit ? "Renseignez-la une fois — elle servira ensuite à chaque dossier." : "Demandez à Legal de la renseigner."}
        </p>
      ) : (
        count.filled < count.total && (
          <p className="text-xs text-muted-foreground">
            {count.filled} champ(s) renseigné(s) sur {count.total} — les champs vides ne sont pas
            copiés dans le bloc.
          </p>
        )
      )}

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {sections.map((s) => (
          <section key={s.key} className="surface overflow-hidden p-0">
            <h2 className="border-b border-border px-3 py-2 text-sm font-semibold sm:px-4">{s.title}</h2>
            <dl className="divide-y divide-border">
              {s.fields.map((f) => {
                const v = company.values[f.key] ?? "";
                return (
                  <div key={f.key} className="flex items-start gap-2 px-3 py-2 sm:px-4">
                    <dt className="w-[42%] shrink-0 text-xs text-muted-foreground">{f.label}</dt>
                    <dd className="min-w-0 flex-1 break-words text-sm">
                      {v ? (f.key === "notes" ? <span className="whitespace-pre-wrap">{v}</span> : v) : <span className="text-muted-foreground">—</span>}
                    </dd>
                    {f.copyable && v && <CopyButton value={v} title={`Copier « ${f.label} »`} />}
                  </div>
                );
              })}
            </dl>
          </section>
        ))}
      </div>

      {/* LES PIÈCES DE L'ENTITÉ — extrait du registre, attestation fiscale, statuts, RIB scanné.
          Rattachées à la société elle-même : c'est ce qu'on joint à un dossier en même temps
          qu'on en recopie les numéros. */}
      <section className="surface space-y-3 p-3 sm:p-4">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <Paperclip className="h-4 w-4 text-primary" /> Pièces de {company.label}
        </h2>
        <p className="text-xs text-muted-foreground">
          Extrait du registre de commerce, attestation fiscale, statuts, RIB scanné — les pièces
          qu&apos;on joint au dossier en même temps qu&apos;on en recopie les numéros.
          {canEdit && " Chaque pièce se renomme d'un clic : c'est son nom qu'on lira, pas celui du fichier."}
        </p>
        {/* Les natures proposées sont CELLES D'UNE SOCIÉTÉ. Le référentiel complet (CTD, Module 3,
            certificat GMP, réserves ANPP…) n'a rien à faire sur des statuts : trente-cinq entrées
            hors sujet à écarter avant de trouver la bonne, et l'on finit par tout mettre « Autre ». */}
        {canEdit && (
          <DocumentUpload entityType="COMPANY" entityId={company.id} categories={[...COMPANY_DOC_CATEGORIES]} />
        )}
        {/* LA LISTE MANQUAIT : on pouvait déposer une pièce et ne jamais la revoir. */}
        <DocumentList
          documents={company.documents}
          canDelete={canEdit} canEdit={canEdit} canRename={canEdit}
          path="/legal/identites"
        />
      </section>

      {editing && (
        <IdentitySheet company={company} sections={sections} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}

/** Bouton de copie avec accusé visuel — sans retour, on colle l'ancien presse-papier. */
function CopyButton({ value, label, title }: { value: string; label?: string; title?: string }) {
  const [done, setDone] = React.useState(false);
  if (!value) return null;
  return (
    <button
      type="button"
      title={title}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        } catch {
          /* presse-papier refusé (contexte non sécurisé) : on ne prétend pas avoir copié */
        }
      }}
      className={cn(
        "flex min-h-9 min-w-9 shrink-0 items-center justify-center gap-1 rounded-lg border px-2 py-1 text-xs font-medium transition-colors sm:min-h-0 sm:min-w-0",
        done ? "border-success/50 text-success" : "border-border text-muted-foreground hover:bg-secondary",
        label ? "" : "px-1.5",
      )}
    >
      {done ? <Check className="h-3.5 w-3.5" /> : label ? <ClipboardList className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {label ? (done ? "Copiée" : label) : null}
    </button>
  );
}

/** Le formulaire de saisie — la carte entière, section par section. */
function IdentitySheet({
  company, sections, onClose,
}: {
  company: IdentityCompany;
  sections: IdentitySection[];
  onClose: () => void;
}) {
  const { busy, err, run } = useAction();

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    fd.set("companyId", company.id);
    await run(() => saveCompanyIdentity(fd), onClose);
  }

  return (
    <Sheet
      open onClose={onClose} width="lg"
      title={`Coordonnées — ${company.label}`}
      description="Un champ laissé vide reste vide : rien n'est deviné, et les champs vides ne sont pas copiés dans le bloc."
    >
      <form onSubmit={submit} className="space-y-4">
        {sections.map((s) => (
          <fieldset key={s.key} className="space-y-2">
            <legend className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{s.title}</legend>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {s.fields.map((f) => (
                <div key={f.key} className={cn("space-y-1.5", f.key === "notes" && "sm:col-span-2")}>
                  <Label htmlFor={`id-${f.key}`}>{f.label}</Label>
                  {f.key === "notes" ? (
                    <Textarea id={`id-${f.key}`} name={f.key} rows={2} defaultValue={company.values[f.key] ?? ""} />
                  ) : (
                    <Input id={`id-${f.key}`} name={f.key} defaultValue={company.values[f.key] ?? ""} />
                  )}
                  {f.hint && <p className="text-xs text-muted-foreground">{f.hint}</p>}
                </div>
              ))}
            </div>
          </fieldset>
        ))}

        {err && <p className="rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{err}</p>}
        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onClose}>Annuler</Button>
          <Button type="submit" disabled={busy}>
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Enregistrer
          </Button>
        </div>
      </form>
    </Sheet>
  );
}
