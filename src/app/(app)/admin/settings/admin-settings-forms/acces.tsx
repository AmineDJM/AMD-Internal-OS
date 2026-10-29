"use client";

/**
 * LES FORMULAIRES DES RÉGLAGES — l'accès par rôle ET par personne : pipeline Regulatory, directives.
 */
import * as React from "react";
import { Loader2, Check, Search } from "lucide-react";
import { setPipelineAccess, setDirectiveAccess } from "@/lib/actions/settings-actions";
import { describePipelineAudience } from "@/lib/regulatory/pipeline-access";
import { describeDirectiveAccess } from "@/lib/directives/access";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import type { AppSettings } from "@/lib/settings";
import type { Opt, UserLite } from "./types";
import { actionFailureMessage } from "@/lib/action-outcome";

/**
 * UN NIVEAU D'ACCÈS — des rôles, et des personnes nommées. Réutilisé pour les deux niveaux du
 * pipeline (consultation / cadenas) : deux blocs écrits deux fois auraient divergé dès la
 * première correction, et l'administrateur aurait eu deux ergonomies pour un même geste.
 */
function RolePeoplePicker({
  title, hint, roles, users, pickedRoles, pickedUsers, onToggleRole, onToggleUser,
}: {
  title: string;
  hint: string;
  roles: Opt[];
  users: UserLite[];
  pickedRoles: string[];
  pickedUsers: string[];
  onToggleRole: (v: string) => void;
  onToggleUser: (id: string) => void;
}) {
  const [query, setQuery] = React.useState("");
  const q = query.trim().toLowerCase();
  // Sans recherche, on n'affiche QUE les personnes déjà choisies : dérouler cent noms pour en
  // cocher deux transforme un réglage en corvée, et l'on finit par ne plus le régler.
  const shown = q ? users.filter((u) => u.name.toLowerCase().includes(q)) : users.filter((u) => pickedUsers.includes(u.id));

  return (
    <div className="space-y-2 rounded-lg border border-border p-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>

      <div className="flex flex-wrap gap-2">
        {roles.filter((r) => r.value !== "SUPER_ADMIN").map((r) => {
          const on = pickedRoles.includes(r.value);
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => onToggleRole(r.value)}
              className={`rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
            >
              {r.label}
            </button>
          );
        })}
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Personnes nommées {pickedUsers.length > 0 ? `(${pickedUsers.length})` : ""}</Label>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Rechercher une personne…" className="h-10 pl-8 text-xs sm:h-8" />
        </div>
        <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
          {shown.length === 0 ? (
            <p className="text-xs text-muted-foreground">{q ? "Aucune personne trouvée." : "Aucune personne ajoutée — cherchez un nom pour en ajouter."}</p>
          ) : shown.map((u) => {
            const on = pickedUsers.includes(u.id);
            return (
              <button
                key={u.id}
                type="button"
                onClick={() => onToggleUser(u.id)}
                className={`rounded-full border px-2.5 py-1.5 text-xs sm:py-1 transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
              >
                {u.name}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * LES ACCÈS AU PIPELINE — deux niveaux, jamais confondus.
 *
 * CONSULTER, c'est lire un portefeuille qu'on n'a pas encore décidé de déposer. TENIR LE CADENAS,
 * c'est le publier à toute l'entreprise — et cela ne se reprend pas : ce qui a été lu a été lu.
 * L'écran affiche donc le second en second, avec sa propre mise en garde, plutôt que de mêler les
 * deux listes dans un seul bloc « accès » où l'on cocherait le mauvais.
 */
export function PipelineAccessForm({ roles, users, settings }: {
  roles: Opt[];
  users: UserLite[];
  settings: Pick<AppSettings, "pipelineViewerRoles" | "pipelineViewerUserIds" | "pipelineManagerRoles" | "pipelineManagerUserIds">;
}) {
  const [viewerRoles, setViewerRoles] = React.useState<string[]>(settings.pipelineViewerRoles);
  const [viewerUsers, setViewerUsers] = React.useState<string[]>(settings.pipelineViewerUserIds);
  const [managerRoles, setManagerRoles] = React.useState<string[]>(settings.pipelineManagerRoles);
  const [managerUsers, setManagerUsers] = React.useState<string[]>(settings.pipelineManagerUserIds);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const flip = (set: React.Dispatch<React.SetStateAction<string[]>>) => (v: string) =>
    set((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  const audience = describePipelineAudience({
    pipelineViewerRoles: viewerRoles,
    pipelineViewerUserIds: viewerUsers,
    pipelineManagerRoles: managerRoles,
    pipelineManagerUserIds: managerUsers,
  });

  return (
    <form
      action={async () => {
        setSaving(true); setError(null);
        const fd = new FormData();
        viewerRoles.forEach((r) => fd.append("viewerRoles", r));
        viewerUsers.forEach((id) => fd.append("viewerUserIds", id));
        managerRoles.forEach((r) => fd.append("managerRoles", r));
        managerUsers.forEach((id) => fd.append("managerUserIds", id));
        try {
          const res = await setPipelineAccess(fd);
          if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
          else setError(res.error ?? "Les accès au pipeline n'ont pas été enregistrés.");
        } catch {
          setError(actionFailureMessage("THROWN"));
        } finally {
          setSaving(false);
        }
      }}
      className="space-y-3"
    >
      <RolePeoplePicker
        title="Consulter les dossiers verrouillés"
        hint="Voir le portefeuille à l'étude — dans le pipeline, mais aussi partout ailleurs (recherche, sélecteurs de produits, assistant). C'est une confidence, pas un pouvoir."
        roles={roles} users={users}
        pickedRoles={viewerRoles} pickedUsers={viewerUsers}
        onToggleRole={flip(setViewerRoles)} onToggleUser={flip(setViewerUsers)}
      />

      <RolePeoplePicker
        title="Tenir le cadenas (ouvrir un dossier)"
        hint="Ouvrir un dossier le rend visible de TOUTE l'entreprise, et cela ne se reprend pas : ce qui a été lu a été lu. À donner à moins de monde que la consultation. Tenir le cadenas donne aussi la consultation."
        roles={roles} users={users}
        pickedRoles={managerRoles} pickedUsers={managerUsers}
        onToggleRole={flip(setManagerRoles)} onToggleUser={flip(setManagerUsers)}
      />

      <p className="text-xs text-muted-foreground">{audience}</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les accès au pipeline"}
      </Button>
    </form>
  );
}

/**
 * ACCÈS AU MODULE DIRECTIVES — qui lit les notes de service, qui en rédige.
 *
 * Le troisième droit, la PUBLICATION, n'apparaît pas ici : il n'est pas réglable. Une note de
 * service engage l'entreprise devant tous ses salariés ; sa signature appartient à la direction
 * générale, en dur dans le code. L'écran le DIT, pour que personne ne cherche la case.
 */
export function DirectiveAccessForm({ roles, users, settings }: {
  roles: Opt[];
  users: UserLite[];
  settings: Pick<AppSettings, "directiveReaderRoles" | "directiveReaderUserIds" | "directiveIssuerRoles" | "directiveIssuerUserIds">;
}) {
  const [readerRoles, setReaderRoles] = React.useState<string[]>(settings.directiveReaderRoles);
  const [readerUsers, setReaderUsers] = React.useState<string[]>(settings.directiveReaderUserIds);
  const [issuerRoles, setIssuerRoles] = React.useState<string[]>(settings.directiveIssuerRoles);
  const [issuerUsers, setIssuerUsers] = React.useState<string[]>(settings.directiveIssuerUserIds);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const flip = (set: React.Dispatch<React.SetStateAction<string[]>>) => (v: string) =>
    set((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  const audience = describeDirectiveAccess({
    directiveReaderRoles: readerRoles,
    directiveReaderUserIds: readerUsers,
    directiveIssuerRoles: issuerRoles,
    directiveIssuerUserIds: issuerUsers,
  });

  return (
    <form
      action={async () => {
        setSaving(true); setError(null);
        const fd = new FormData();
        readerRoles.forEach((r) => fd.append("readerRoles", r));
        readerUsers.forEach((id) => fd.append("readerUserIds", id));
        issuerRoles.forEach((r) => fd.append("issuerRoles", r));
        issuerUsers.forEach((id) => fd.append("issuerUserIds", id));
        try {
          const res = await setDirectiveAccess(fd);
          if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
          else setError(res.error ?? "Les accès aux directives n'ont pas été enregistrés.");
        } catch {
          setError(actionFailureMessage("THROWN"));
        } finally {
          setSaving(false);
        }
      }}
      className="space-y-3"
    >
      <RolePeoplePicker
        title="Lire les directives"
        hint="Recevoir et consulter les notes de service qui vous concernent. C'est le cas ordinaire : presque tout le monde doit lire les notes de la direction."
        roles={roles} users={users}
        pickedRoles={readerRoles} pickedUsers={readerUsers}
        onToggleRole={flip(setReaderRoles)} onToggleUser={flip(setReaderUsers)}
      />

      <RolePeoplePicker
        title="Rédiger une directive"
        hint="Écrire une note et la SOUMETTRE. Ce n'est pas la publier : elle attendra l'accord de la direction générale. Rédiger donne aussi la lecture."
        roles={roles} users={users}
        pickedRoles={issuerRoles} pickedUsers={issuerUsers}
        onToggleRole={flip(setIssuerRoles)} onToggleUser={flip(setIssuerUsers)}
      />

      <p className="rounded-lg bg-secondary px-3 py-2 text-xs text-muted-foreground">
        <strong className="text-foreground">La publication ne se règle pas.</strong> Une note de service
        engage l&apos;entreprise devant tous ses salariés : seuls le <strong>Directeur Général</strong> et le
        <strong> Super Admin</strong> la prononcent, et cela ne s&apos;ouvre pas depuis cet écran.
      </p>
      <p className="text-xs text-muted-foreground">{audience}</p>
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les accès aux directives"}
      </Button>
    </form>
  );
}
