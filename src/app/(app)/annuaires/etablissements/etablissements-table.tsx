"use client";

import * as React from "react";
import { Building2, Layers, Loader2, MapPin, Pencil, Plus, Power, PowerOff, Stethoscope, Trash2 } from "lucide-react";
import { createInstitution, updateInstitution, deleteInstitution } from "@/lib/actions/medical-actions";
import { colorerCellulesAnnuaire } from "@/lib/actions/annuaire-couleurs-actions";
import { Button } from "@/components/ui/button";
import { Sheet } from "@/components/ui/sheet";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { ALGERIA_WILAYAS } from "@/lib/labels";
import { ETABLISSEMENT_COLUMNS, type EtablissementField } from "@/lib/medical/etablissements-grid";
import { cleCellule, type CouleurCellule } from "@/lib/grille/couleurs";
import { useSelectionGrille } from "@/components/grille/use-selection";
import { BarreSelection, DockSelection, classeCouleurCellule } from "@/components/grille/barre-selection";
import { useTableur, type ColonneTableur } from "@/components/grille/use-tableur";
import { BarreTableur } from "@/components/grille/barre-tableur";
import { CelluleEnTete } from "@/components/grille/en-tete-filtre";
import { ServicesPanel } from "./services-panel";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { useConfirmer } from "@/components/ui/dialogue";
import { actionFailureMessage } from "@/lib/action-outcome";

import type { EtablissementRow } from "@/lib/annuaires/types";

export type { EtablissementRow };

/** Largeurs de départ (px) des colonnes de la feuille — chacune s'élargit ensuite en glissant son bord. */
const LARGEURS: Record<EtablissementField, number> = {
  name: 260, type: 150, sector: 120, wilaya: 140, services: 280, doctorCount: 110, sectorCount: 110,
};
const COLONNES_TABLEUR: ColonneTableur[] = ETABLISSEMENT_COLUMNS.map((c) => ({
  cle: c.field, libelle: c.header, largeur: LARGEURS[c.field], masquable: c.field !== "name",
}));
/** La colonne des gestes de la ligne (modifier, désactiver, supprimer). */
const LARGEUR_ACTIONS = 120;

/**
 * L'ANNUAIRE DES ÉTABLISSEMENTS — CHU, EPH, EHS, cliniques, polycliniques, cabinets.
 *
 * ── POURQUOI CET ÉCRAN N'EXISTAIT PAS, ET CE QUE ÇA COÛTAIT ────────────────────────────────
 *
 * `MedicalInstitution` est en base depuis toujours, avec ses trois écritures
 * (`createInstitution`, `updateInstitution`, `deleteInstitution`) — classées, décrites, et
 * appelables par ADAM. Recensé : leurs seuls importeurs étaient `assistant.ts` et le catalogue
 * d'ops. AUCUN écran. Le référentiel existait, ses écritures existaient, la conversation savait
 * s'en servir, et personne devant un écran ne pouvait en ajouter un — §118.14 dans sa forme
 * exacte, et §118.50 pour l'écran.
 *
 * ── LA WILAYA EST LE SEUL DÉCOUPAGE (décision de la Direction, 09/2026) ─────────────────
 *
 * Le formulaire portait « Ville » ET « Wilaya », deux textes libres côte à côte : « Alger »,
 * « ALGER » et « Alger centre » faisaient trois lieux pour le logiciel. La ville a disparu ; la
 * wilaya se CHOISIT dans la liste fermée des 58 (`ALGERIA_WILAYAS`, la même liste que la
 * feuille des praticiens et que le plan de tournée), et l'action serveur refuse tout ce qui n'en
 * fait pas partie.
 *
 * ── LA FEUILLE SE SÉLECTIONNE ET SE COLORE (§118.133) ─────────────────────────────────────
 *
 * Même mécanique que l'annuaire des praticiens : un clic prend une cellule, Maj étend, Ctrl
 * ajoute, glisser étend ; la barre colore, efface, copie. La couleur est partagée et se pose
 * sous le droit de modification du module — un référentiel n'a pas de portée par ligne.
 *
 * ── CE QUE LA SUPPRESSION EMPORTE, DIT AVANT LE CLIC ───────────────────────────────────────
 *
 * Les praticiens rattachés ne sont PAS supprimés (clé étrangère `SetNull`) : ils basculent en
 * « sans établissement ». Mais les SECTEURS commerciaux qui le contenaient le perdent en
 * cascade, et un KAM dont le secteur se vide n'a plus de médecin à visiter. Les deux comptes
 * sont donc affichés sur la ligne ET répétés dans la confirmation : c'est la conséquence, pas la
 * ligne supprimée, qu'on doit lire avant de décider.
 */
export function EtablissementsTable({
  rows, couleurs, types, sectors, canCreate, canEdit, canDelete, suggestionsServices = [],
}: {
  rows: EtablissementRow[];
  /** Les couleurs posées sur la feuille — `<id>:<colonne>` → clé de palette. */
  couleurs: Record<string, string>;
  /** Libellés du référentiel commun (`lib/labels.ts`) — jamais réécrits ici. */
  types: { value: string; label: string }[];
  sectors: { value: string; label: string }[];
  canCreate: boolean;
  canEdit: boolean;
  canDelete: boolean;
  /** Les spécialités connues, PROPOSÉES à la saisie d'un service (§118.172) — jamais imposées. */
  suggestionsServices?: string[];
}) {
  // Les gestes attendent que l'écran ait reçu ses nouvelles données : une fiche ouverte
  // avant porterait l'état d'AVANT, et l'enregistrer le réécrirait (§118.172).
  const { enCours: rafraichit, rafraichir } = useRafraichir();
  const confirmer = useConfirmer();
  // LE PANNEAU DES SERVICES suit la LIGNE par son identifiant, relue à chaque rendu : garder
  // l'objet de la ligne montrerait la liste d'avant l'ajout, jusqu'à ce qu'on le referme.
  const [servicesDeId, setServicesDeId] = React.useState<string | null>(null);
  const servicesDe = servicesDeId ? rows.find((r) => r.id === servicesDeId) ?? null : null;
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<EtablissementRow | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  const [couleursLocales, setCouleursLocales] = React.useState<Record<string, string>>(couleurs);
  React.useEffect(() => { setCouleursLocales(couleurs); }, [couleurs]);
  const [msgCouleur, setMsgCouleur] = React.useState<{ ok: boolean; text: string } | null>(null);

  const occupe = busy || rafraichit;

  const labelType = (v: string) => types.find((t) => t.value === v)?.label ?? v;
  const labelSector = (v: string) => sectors.find((s) => s.value === v)?.label ?? v;

  const run = async (action: (fd: FormData) => Promise<{ ok: boolean; error?: string }>, fd: FormData) => {
    setBusy(true); setErr(null);
    try {
      const r = await action(fd);
      if (!r.ok) { setErr(r.error ?? "L'établissement n'a pas été modifié."); return false; }
      rafraichir();
      return true;
    } catch {
      setErr(actionFailureMessage("THROWN"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const remove = async (e: EtablissementRow) => {
    const consequences = [
      e.doctorCount > 0 ? `${e.doctorCount} praticien(s) passeront en « sans établissement » (ils ne sont PAS supprimés)` : null,
      e.sectorCount > 0 ? `${e.sectorCount} secteur(s) commercial(aux) le perdront — un KAM dont le secteur se vide n'a plus de médecin à visiter` : null,
      e.services.length > 0 ? `ses ${e.services.length} service(s) sont supprimés avec lui` : null,
    ].filter(Boolean);
    const msg = `Supprimer « ${e.name} » ?`
      + (consequences.length ? `\n\n${consequences.map((c) => `• ${c}`).join("\n")}` : "");
    if (!(await confirmer(msg))) return;
    const fd = new FormData();
    fd.set("id", e.id);
    await run(deleteInstitution, fd);
  };

  /**
   * DÉSACTIVER / RÉACTIVER EN UN CLIC (§118.172). Le formulaire de la fiche portait une case
   * « actif » que le serveur lisait de travers : enregistrer un établissement actif le
   * désactivait, et le réactiver était impossible. Le geste vit maintenant aussi sur la ligne, et
   * n'envoie que l'identifiant et l'état — `updateInstitution` laisse le reste tel quel.
   */
  const basculerActif = async (e: EtablissementRow) => {
    if (e.isActive && !(await confirmer(
      `Désactiver « ${e.name} » ?\n\nIl ne se proposera plus au rattachement d'un praticien ni au découpage d'un secteur. `
      + "Les praticiens et les secteurs qui le portent déjà le gardent.",
    ))) return;
    const fd = new FormData();
    fd.set("id", e.id);
    fd.set("isActive", e.isActive ? "off" : "on");
    await run(updateInstitution, fd);
  };

  /** La valeur AFFICHÉE d'une cellule — la même pour l'écran, la copie, le filtre et le tri. */
  const valeurCellule = React.useCallback((row: EtablissementRow, field: EtablissementField): string => {
    switch (field) {
      case "name": return row.name;
      case "type": return labelType(row.type);
      case "sector": return labelSector(row.sector);
      case "wilaya": return row.wilaya ?? "";
      case "services": return row.services.map((s) => s.name).join(", ");
      case "doctorCount": return String(row.doctorCount);
      case "sectorCount": return String(row.sectorCount);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [types, sectors]);

  // COMME EXCEL (recette du 23/11) : filtre automatique par colonne (le menu « Tous les types » d'avant n'en était
  // qu'un), tri, largeur et affichage des colonnes. LE FILTRE EST CLIENT : le parc d'établissements se compte en
  // centaines, pas en dizaines de milliers — un aller-retour serveur par frappe coûterait plus que le gain.
  const acces = React.useCallback((row: EtablissementRow, cle: string) => valeurCellule(row, cle as EtablissementField), [valeurCellule]);
  const texteLigne = React.useCallback(
    (r: EtablissementRow) => [...ETABLISSEMENT_COLUMNS.map((c) => valeurCellule(r, c.field)), r.region, r.phone, r.email].filter(Boolean).join(" "),
    [valeurCellule],
  );
  const tableur = useTableur({ lignes: rows, colonnes: COLONNES_TABLEUR, acces, texteLigne });
  const visibles = tableur.visibles;
  const colonnes = ETABLISSEMENT_COLUMNS.filter((c) => !tableur.masquees.has(c.field));

  const grille = useSelectionGrille({
    lignes: visibles.length,
    colonnes: colonnes.length,
    valeur: (r, c) => {
      const row = visibles[r]; const col = colonnes[c];
      return row && col ? valeurCellule(row, col.field) : "";
    },
  });

  const appliquerCouleur = (couleur: CouleurCellule | null) => {
    const cibles = grille.cellules
      .map(({ r, c }) => ({ id: visibles[r]?.id ?? "", field: colonnes[c]?.field ?? "" }))
      .filter((c) => c.id && c.field);
    if (cibles.length === 0) return;
    const avant = couleursLocales;
    const apres = { ...avant };
    for (const c of cibles) {
      const k = cleCellule(c.id, c.field);
      if (couleur) apres[k] = couleur; else delete apres[k];
    }
    setCouleursLocales(apres);
    setBusy(true); setMsgCouleur(null);
    void colorerCellulesAnnuaire({ feuille: "etablissements", cellules: cibles.map((c) => cleCellule(c.id, c.field)), couleur }).then((r) => {
      setBusy(false);
      if (!r.ok) { setCouleursLocales(avant); setMsgCouleur({ ok: false, text: r.error ?? "Coloration refusée." }); return; }
      if (r.ignorees > 0) setMsgCouleur({ ok: true, text: r.message ?? "" });
      rafraichir();
    }, () => {
      setBusy(false);
      setCouleursLocales(avant);
      setMsgCouleur({ ok: false, text: actionFailureMessage("THROWN") });
    });
  };

  const wilayaHorsListe = editing?.wilaya && !ALGERIA_WILAYAS.includes(editing.wilaya) ? editing.wilaya : null;

  return (
    <div className="space-y-4">
      <BarreTableur pilote={tableur} placeholder="Chercher un établissement, une wilaya…" etiquette="Chercher un établissement">
        {canCreate && (
          <Button onClick={() => { setErr(null); setCreating(true); }} disabled={occupe} className="w-full sm:w-auto">
            <Plus className="h-4 w-4" /> Ajouter un établissement
          </Button>
        )}
      </BarreTableur>

      {/* L'EN-TÊTE RESTE COLLÉ et la colonne des noms FIGÉE pendant que la feuille défile dans son cadre (« comme
          Excel ») ; les fonds sont opaques, sinon le texte des voisines défilerait sous la colonne figée. */}
      <div {...grille.propsConteneur} className="max-h-[75vh] overflow-auto rounded-xl border border-border outline-none focus-visible:ring-1 focus-visible:ring-ring">
        <table className="min-w-full table-fixed select-none border-separate border-spacing-0 text-[13px]" style={{ width: colonnes.reduce((s, c) => s + tableur.largeur(c.field), LARGEUR_ACTIONS) }}>
          <colgroup>
            {colonnes.map((c) => <col key={c.field} style={{ width: tableur.largeur(c.field) }} />)}
            <col style={{ width: LARGEUR_ACTIONS }} />
          </colgroup>
          <thead>
            <tr>
              {colonnes.map((c, j) => (
                <CelluleEnTete
                  key={c.field} pilote={tableur} colonne={COLONNES_TABLEUR.find((x) => x.cle === c.field)!}
                  className={cn("sticky top-0 border-b border-r border-border bg-secondary text-muted-foreground", j === 0 ? "left-0 z-30" : "z-20")}
                />
              ))}
              <th scope="col" className="sticky top-0 z-20 border-b border-border bg-secondary"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody>
            {visibles.length === 0 && (
              <tr>
                <td colSpan={colonnes.length + 1} className="px-3 py-8 text-center text-muted-foreground">
                  {rows.length === 0
                    ? "Aucun établissement dans l'annuaire. C'est lui qui permet de rattacher un praticien à un vrai hôpital, et de découper les secteurs de la force de vente."
                    : "Aucun établissement ne correspond aux filtres et à la recherche."}
                </td>
              </tr>
            )}
            {visibles.map((e, r) => {
              const fond = r % 2 === 1 ? "bg-muted" : "bg-card";
              const cellule = (c: number, field: EtablissementField, contenu: React.ReactNode, extra?: string) => {
                const couleur = couleursLocales[cleCellule(e.id, field)];
                return (
                  <td
                    key={field}
                    {...grille.propsCellule(r, c)}
                    className={cn(
                      "scroll-mt-10 border-b border-r border-border px-2 py-1 align-middle",
                      c === 0 && "sticky left-0 z-10",
                      couleur ? classeCouleurCellule(couleur) : cn(fond, "group-hover:bg-accent"),
                      grille.estSelectionnee(r, c) && "shadow-[inset_0_0_0_2px_hsl(var(--primary))]",
                      grille.estSelectionnee(r, c) && !couleur && "bg-accent",
                      extra,
                    )}
                  >
                    {contenu}
                  </td>
                );
              };
              const contenus: Record<EtablissementField, () => React.ReactNode> = {
                name: () => (
                    <>
                      <span className="flex items-center gap-2 font-medium">
                        <Building2 className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                        {e.name}
                        {!e.isActive && <Badge tone="neutral">Inactif</Badge>}
                      </span>
                      {e.phone || e.email ? (
                        <span className="mt-0.5 block truncate text-xs text-muted-foreground">{[e.phone, e.email].filter(Boolean).join(" · ")}</span>
                      ) : null}
                    </>
                ),
                type: () => labelType(e.type),
                sector: () => <Badge tone={e.sector === "PUBLIC" ? "info" : "purple"}>{labelSector(e.sector)}</Badge>,
                wilaya: () => (
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <MapPin className="h-3.5 w-3.5 shrink-0" aria-hidden />
                      {e.wilaya || "—"}
                    </span>
                ),
                services: () => (
                    // LES SERVICES (§118.172) : les premiers en clair, le reste compté, et le
                    // panneau à un clic — qui ne peut pas modifier l'y LIT sans bouton.
                    <span className="flex flex-wrap items-center gap-1">
                      {e.services.slice(0, 3).map((s) => (
                        <span key={s.id} className="rounded-md bg-muted px-1.5 py-0.5 text-xs">{s.name}</span>
                      ))}
                      {e.services.length > 3 && <span className="text-xs text-muted-foreground">+{e.services.length - 3}</span>}
                      <button
                        type="button" onClick={(ev) => { ev.stopPropagation(); setServicesDeId(e.id); }}
                        onMouseDown={(ev) => ev.stopPropagation()}
                        className="inline-flex items-center gap-1 rounded-md px-2 py-1.5 text-xs text-primary hover:bg-primary/10 sm:px-1.5 sm:py-0.5"
                        aria-label={`Services de ${e.name}`}
                      >
                        <Layers className="h-3.5 w-3.5" aria-hidden />
                        {e.services.length === 0 ? (canEdit ? "Ajouter" : "Aucun") : canEdit ? "Gérer" : "Voir"}
                      </button>
                    </span>
                ),
                doctorCount: () => (e.doctorCount > 0
                  ? <span className="inline-flex items-center gap-1"><Stethoscope className="h-3.5 w-3.5 text-muted-foreground" aria-hidden />{e.doctorCount}</span>
                  : <span className="text-muted-foreground">—</span>),
                sectorCount: () => (e.sectorCount > 0 ? e.sectorCount : <span className="text-muted-foreground">—</span>),
              };
              return (
                <tr key={e.id} className={cn("group", !e.isActive && "text-muted-foreground")}>
                  {colonnes.map((col, c) => cellule(c, col.field, contenus[col.field](), col.calculee ? "text-right tabular-nums" : undefined))}
                  <td className={cn("border-b border-border px-1 py-0.5 group-hover:bg-accent", fond)}>
                    <span className="flex items-center justify-end gap-1">
                      {canEdit && (
                        <button
                          type="button" onClick={() => { setErr(null); setEditing(e); }} disabled={occupe}
                          className="rounded-md p-2.5 text-muted-foreground hover:bg-muted hover:text-foreground sm:p-1.5"
                          aria-label={`Modifier ${e.name}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                      )}
                      {canEdit && (
                        <button
                          type="button" onClick={() => void basculerActif(e)} disabled={occupe}
                          className="rounded-md p-2.5 text-muted-foreground hover:bg-muted hover:text-foreground sm:p-1.5"
                          aria-label={e.isActive ? `Désactiver ${e.name}` : `Réactiver ${e.name}`}
                          title={e.isActive ? "Désactiver" : "Réactiver"}
                        >
                          {e.isActive ? <PowerOff className="h-4 w-4" /> : <Power className="h-4 w-4 text-success" />}
                        </button>
                      )}
                      {canDelete && (
                        <button
                          type="button" onClick={() => void remove(e)} disabled={occupe}
                          className="rounded-md p-2.5 text-muted-foreground hover:bg-destructive/10 hover:text-destructive sm:p-1.5"
                          aria-label={`Supprimer ${e.name}`}
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* SOUS le tableau et dans le flux, jamais au-dessus ni collé au bas de l'écran : une barre qui
          surgit au-dessus le décale, une barre collée en bas recouvre la dernière ligne — dans les
          deux cas le clic suivant tombe ailleurs (§118.172, `DockSelection`). */}
      <DockSelection>
        {err && <p role="alert" className="rounded-lg border border-destructive/40 bg-card px-3 py-2 text-sm text-destructive">{err}</p>}
        <BarreSelection
          nombre={grille.nombre}
          peutColorer={canEdit}
          busy={occupe}
          onCouleur={(c) => appliquerCouleur(c)}
          onEffacer={() => appliquerCouleur(null)}
          onCopier={grille.copier}
          onFermer={grille.vider}
          message={msgCouleur}
        />
      </DockSelection>

      <p className="text-xs text-muted-foreground">
        {visibles.length} établissement(s) affiché(s) sur {rows.length}.
        {canEdit && " Un clic sélectionne une cellule, Maj étend, Ctrl ajoute ; la barre colore et copie la sélection."}
      </p>

      <ServicesPanel
        etablissement={servicesDe}
        canEdit={canEdit}
        suggestions={suggestionsServices}
        onClose={() => setServicesDeId(null)}
      />

      <Sheet
        open={creating || editing !== null}
        onClose={() => { setCreating(false); setEditing(null); }}
        title={editing ? `Modifier « ${editing.name} »` : "Ajouter un établissement"}
        description="Le nom est ce que la force de vente lit sur un plan de tournée — écrivez-le comme il se dit."
        width="md"
      >
        <form
          className="space-y-3"
          action={async (fd) => {
            if (editing) fd.set("id", editing.id);
            // `run` est gardé (try/catch/finally) : il rend faux sur refus comme sur levée.
            if (await run(editing ? updateInstitution : createInstitution, fd)) { setCreating(false); setEditing(null); }
          }}
        >
          <div>
            <Label htmlFor="etab-name">Nom de l&apos;établissement</Label>
            <Input id="etab-name" name="name" required defaultValue={editing?.name ?? ""} placeholder="CHU Mustapha Bacha" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="etab-type">Type</Label>
              <Select id="etab-type" name="type" defaultValue={editing?.type ?? "AUTRE"}>
                {types.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </Select>
            </div>
            <div>
              {/* PUBLIC OU PRIVÉ — un attribut de l'établissement, pas un secteur commercial : les
                  secteurs se découpent dans la configuration de chaque Business Unit (§118.172). */}
              <Label htmlFor="etab-sector">Public / privé</Label>
              <Select id="etab-sector" name="sector" defaultValue={editing?.sector ?? "PUBLIC"}>
                {sectors.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              </Select>
            </div>
            <div>
              <Label htmlFor="etab-wilaya">Wilaya</Label>
              {/* LA LISTE FERMÉE DES 58 — la même que la feuille des praticiens. Une valeur héritée
                  hors liste n'est pas pré-sélectionnée en silence : on la nomme, et l'on demande de
                  choisir. */}
              <Select id="etab-wilaya" name="wilaya" defaultValue={wilayaHorsListe ? "" : (editing?.wilaya ?? "")}>
                <option value="">—</option>
                {ALGERIA_WILAYAS.map((w) => <option key={w} value={w}>{w}</option>)}
              </Select>
              {wilayaHorsListe && (
                <p className="mt-1 text-xs text-warning">
                  Valeur actuelle hors liste : « {wilayaHorsListe} » — choisissez la wilaya dans le menu.
                </p>
              )}
            </div>
            <div>
              <Label htmlFor="etab-region">Région</Label>
              <Input id="etab-region" name="region" defaultValue={editing?.region ?? ""} placeholder="Centre" />
            </div>
            <div>
              <Label htmlFor="etab-phone">Téléphone</Label>
              <Input id="etab-phone" name="phone" type="tel" autoComplete="tel" defaultValue={editing?.phone ?? ""} />
            </div>
            <div>
              <Label htmlFor="etab-email">E-mail</Label>
              <Input id="etab-email" name="email" type="email" autoComplete="email" defaultValue={editing?.email ?? ""} />
            </div>
            <div className="sm:col-span-2">
              <Label htmlFor="etab-address">Adresse</Label>
              <Input id="etab-address" name="address" defaultValue={editing?.address ?? ""} />
            </div>
          </div>
          <div>
            <Label htmlFor="etab-notes">Notes</Label>
            <Textarea id="etab-notes" name="notes" rows={2} defaultValue={editing?.notes ?? ""} />
          </div>
          {editing && (
            <label className="flex items-center gap-2 text-sm">
              {/* La case NON cochée doit ENVOYER « off » : `updateInstitution` distingue
                  « on » / « off » / absent, et un champ absent laisse l'état INCHANGÉ. Sans ce
                  champ caché, décocher n'aurait aucun effet — un geste sans conséquence, en
                  silence. */}
              <input type="hidden" name="isActive" value="off" />
              <input type="checkbox" name="isActive" value="on" defaultChecked={editing.isActive} className="h-4 w-4 rounded border-input" />
              Établissement actif (un établissement inactif ne se propose plus au rattachement)
            </label>
          )}
          {err && <p className="text-sm text-destructive">{err}</p>}
          <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => { setCreating(false); setEditing(null); }} disabled={occupe}>
              Annuler
            </Button>
            <Button type="submit" disabled={occupe}>
              {occupe && <Loader2 className="h-4 w-4 animate-spin" />}
              {editing ? "Enregistrer" : "Ajouter"}
            </Button>
          </div>
        </form>
      </Sheet>
    </div>
  );
}
