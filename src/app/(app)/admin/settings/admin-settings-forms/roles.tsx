"use client";

/**
 * LES FORMULAIRES DES RÉGLAGES — qui peut quoi, par rôle : espaces Drive, messages promo, synthèse
 * des rapports terrain, organigramme, modules masqués.
 */
import * as React from "react";
import { Loader2, Check, Search, Eye, EyeOff } from "lucide-react";
import { setDriveSpaceCreatorRoles, setFieldReportsOverviewRoles, setPromoMessageAuthorRoles, setOrgChartViewers, setHiddenModules } from "@/lib/actions/settings-actions";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { hiddenSummary } from "@/lib/modules-visibility";
import type { Opt, UserLite } from "./types";

/** Sélection des rôles autorisés à CRÉER des catégories de Drive (Super Admin toujours inclus). */
export function DriveSpaceCreatorForm({ roles, selected }: { roles: Opt[]; selected: string[] }) {
  const [picked, setPicked] = React.useState<string[]>(selected);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  return (
    <form
      action={async () => {
        setSaving(true);
        const fd = new FormData();
        picked.forEach((r) => fd.append("roles", r));
        const res = await setDriveSpaceCreatorRoles(fd);
        setSaving(false);
        if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
      }}
      className="space-y-3"
    >
      <div className="flex flex-wrap gap-2">
        {roles.filter((r) => r.value !== "SUPER_ADMIN").map((r) => {
          const on = picked.includes(r.value);
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => toggle(r.value)}
              className={`rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">Le Super Admin peut toujours créer des catégories de Drive (espaces partagés type « Promotion Médicale », présentés en onglets). Ajoutez ici les rôles qui pourront aussi en créer et gérer les accès.</p>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les créateurs"}
      </Button>
    </form>
  );
}

/**
 * Rôles autorisés à ÉCRIRE les messages pré-définis de la Direction Marketing.
 *
 * Le référentiel VIDE fait refuser tous les rapports terrain (ils en exigent au moins un) : ce
 * réglage n'est donc pas un confort, c'est ce qui rend le module utilisable.
 */
export function PromoMessageAuthorsForm({ roles, selected }: { roles: Opt[]; selected: string[] }) {
  const [picked, setPicked] = React.useState<string[]>(selected);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  return (
    <form
      action={async () => {
        setSaving(true);
        const fd = new FormData();
        picked.forEach((r) => fd.append("roles", r));
        const res = await setPromoMessageAuthorRoles(fd);
        setSaving(false);
        if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
      }}
      className="space-y-3"
    >
      <div className="flex flex-wrap gap-2">
        {roles.filter((r) => r.value !== "SUPER_ADMIN").map((r) => {
          const on = picked.includes(r.value);
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => toggle(r.value)}
              className={`rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Chaque rapport terrain exige au moins un message pré-défini : tant que personne ne peut en publier, tous les
        rapports sont refusés. Une LISTE DE RÔLES plutôt qu&apos;un droit de module — Direction Marketing n&apos;a que
        la lecture sur la promotion médicale, et lui donner l&apos;écriture du module ouvrirait aussi les praticiens et
        les visites.
      </p>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les auteurs"}
      </Button>
    </form>
  );
}

/** Sélection des rôles autorisés à voir l'onglet « Overview » des Rapports terrain (Super Admin toujours inclus). */
export function FieldReportsOverviewForm({ roles, selected }: { roles: Opt[]; selected: string[] }) {
  const [picked, setPicked] = React.useState<string[]>(selected);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  return (
    <form
      action={async () => {
        setSaving(true);
        const fd = new FormData();
        picked.forEach((r) => fd.append("roles", r));
        const res = await setFieldReportsOverviewRoles(fd);
        setSaving(false);
        if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
      }}
      className="space-y-3"
    >
      <div className="flex flex-wrap gap-2">
        {roles.filter((r) => r.value !== "SUPER_ADMIN").map((r) => {
          const on = picked.includes(r.value);
          return (
            <button
              key={r.value}
              type="button"
              onClick={() => toggle(r.value)}
              className={`rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
            >
              {r.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">Le Super Admin voit toujours l'onglet « Overview » (graphes d'analyse des rapports terrain : visites par médecin, hôpital, délégué…). Ajoutez ici les rôles qui pourront aussi le consulter.</p>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer l'accès Overview"}
      </Button>
    </form>
  );
}

/**
 * ORGANIGRAMME — qui peut le CONSULTER : des rôles (les RH au premier chef) et/ou des personnes
 * nommées. Le Super Admin reste seul à le RÉORGANISER. Deux listes plutôt qu'une : « tous les
 * RH » est une règle durable, « cette personne-là » un cas particulier — les confondre obligerait
 * à créer un rôle pour chaque exception.
 */
export function OrgChartViewersForm({ roles, users, selectedRoles, selectedUserIds }: {
  roles: Opt[];
  users: UserLite[];
  selectedRoles: string[];
  selectedUserIds: string[];
}) {
  const [picked, setPicked] = React.useState<string[]>(selectedRoles);
  const [pickedUsers, setPickedUsers] = React.useState<string[]>(selectedUserIds);
  const [query, setQuery] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));
  const toggleUser = (id: string) => setPickedUsers((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const q = query.trim().toLowerCase();
  const shown = q ? users.filter((u) => u.name.toLowerCase().includes(q)) : users.filter((u) => pickedUsers.includes(u.id));

  return (
    <form
      action={async () => {
        setSaving(true);
        const fd = new FormData();
        picked.forEach((r) => fd.append("roles", r));
        pickedUsers.forEach((id) => fd.append("userIds", id));
        const res = await setOrgChartViewers(fd);
        setSaving(false);
        if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
      }}
      className="space-y-3"
    >
      <div className="space-y-1.5">
        <Label className="text-xs">Rôles autorisés</Label>
        <div className="flex flex-wrap gap-2">
          {roles.filter((r) => r.value !== "SUPER_ADMIN").map((r) => {
            const on = picked.includes(r.value);
            return (
              <button
                key={r.value}
                type="button"
                onClick={() => toggle(r.value)}
                className={`rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
              >
                {r.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="space-y-1.5">
        <Label className="text-xs">Personnes nommément autorisées {pickedUsers.length > 0 ? `(${pickedUsers.length})` : ""}</Label>
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
                onClick={() => toggleUser(u.id)}
                className={`rounded-full border px-2.5 py-1.5 text-xs sm:py-1 transition-colors ${on ? "border-primary bg-primary/10 text-primary" : "border-input text-muted-foreground hover:bg-secondary"}`}
              >
                {u.name}
              </button>
            );
          })}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">Les personnes autorisées consultent l'organigramme sur <strong>/organigramme</strong>, filtrable par entité ou sur le groupe entier. Seul le Super Admin modifie les rattachements, les postes et la carte.</p>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les accès"}
      </Button>
    </form>
  );
}

/**
 * MASQUER / DÉMASQUER DES MODULES.
 *
 * Le geste est RÉVERSIBLE et le formulaire le dit : masquer ne supprime rien — ni les données,
 * ni les droits. C'est ce qui permet de couper un module en refonte sans se demander ce qu'on
 * perd, et de le rallumer d'un clic.
 *
 * Les pastilles montrent l'état RÉEL : une pastille allumée = module masqué. On lit donc l'écran
 * comme on lit un tableau de bord — ce qui est éteint se voit d'un coup d'œil, sans compter.
 */
export function HiddenModulesForm({ modules, selected }: { modules: Opt[]; selected: string[] }) {
  const [picked, setPicked] = React.useState<string[]>(selected);
  const [saving, setSaving] = React.useState(false);
  const [saved, setSaved] = React.useState(false);
  const toggle = (v: string) => setPicked((p) => (p.includes(v) ? p.filter((x) => x !== v) : [...p, v]));

  return (
    <form
      action={async () => {
        setSaving(true);
        const fd = new FormData();
        picked.forEach((m) => fd.append("modules", m));
        const res = await setHiddenModules(fd);
        setSaving(false);
        if (res.ok) { setSaved(true); setTimeout(() => setSaved(false), 1500); }
      }}
      className="space-y-3"
    >
      <p className="text-xs text-muted-foreground">{hiddenSummary(picked)}</p>
      <div className="flex flex-wrap gap-2">
        {modules.map((m) => {
          const off = picked.includes(m.value);
          return (
            <button
              key={m.value}
              type="button"
              onClick={() => toggle(m.value)}
              aria-pressed={off}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs sm:py-1 font-medium transition-colors ${off ? "border-destructive/50 bg-destructive/10 text-destructive" : "border-input text-muted-foreground hover:bg-secondary"}`}
            >
              {off ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              {m.label}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Un module masqué disparaît du menu <strong>et devient injoignable par son adresse</strong> — sinon
        « masqué » ne voudrait dire que « absent du menu ». <strong>Rien n&apos;est supprimé</strong> : les
        données, les droits et les circuits restent en place, et démasquer rend le module tel qu&apos;il était.
        Vous continuez de le voir, vous seul. La Console d&apos;Administration ne peut pas être masquée :
        c&apos;est par elle qu&apos;on rallume.
      </p>
      <Button type="submit" size="sm" disabled={saving}>
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : saved ? <Check className="h-4 w-4" /> : null}
        {saved ? "Enregistré" : "Enregistrer les modules en service"}
      </Button>
    </form>
  );
}
