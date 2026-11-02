"use client";

import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { AlertCircle, ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Sheet } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";
import {
  CIBLE_COMPTAGE_LABEL, FREQUENCE_COMPTAGE_LABEL, STATUT_COMPTAGE_LABEL, libelleFamilleComptage, partitionComptage,
  peutAnnulerComptage, peutDemanderDesComptages, peutGererRecurrence, peutSaisirComptage,
} from "@/lib/promo/comptages";
import {
  reprendreRecurrenceComptage, saisirComptage, supprimerRecurrenceComptage, suspendreRecurrenceComptage, corrigerComptage,
} from "@/lib/actions/promo-comptage-actions";
import type { ComptageVue, PageStock, RecurrenceVue } from "@/lib/queries/promo-stock";
import { Section, Vide, date, jour, nombre, nomDe, quantiteDe } from "./stock-commun";
import type { Ctx } from "./stock-vues";

/**
 * LES COMPTAGES DU STOCK (§118.168) — ce qu'on me demande de compter, ce que j'ai demandé, les
 * comptages réguliers, et ce que les derniers comptages ont trouvé.
 *
 * Chaque bouton est montré APRÈS avoir interrogé la règle pure (`promo/comptages.ts`) que l'action
 * relit. Le formulaire de saisie dessine ses lignes avec la MÊME partition que l'action
 * (`partitionComptage`) : un formulaire qui oublierait un article que l'action exige serait refusé
 * « article manquant » sans que la personne puisse voir lequel (§118.5).
 */

const fd = (entrees: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entrees)) f.set(k, v);
  return f;
};

const TON_STATUT = { DEMANDE: "info", SAISI: "success", ANNULE: "neutral" } as const;

function quiCompte(page: PageStock, c: { holderId: string | null }): string {
  return c.holderId === null ? "Magasin central" : nomDe(page, c.holderId);
}

export function VueComptages({ ctx }: { ctx: Ctx }) {
  const { page, f } = ctx;
  const [saisie, setSaisie] = React.useState<ComptageVue | null>(null);
  const aSaisir = page.comptages.filter((c) => c.statut === "DEMANDE" && peutSaisirComptage(f, c.holderId));
  const enCours = page.comptages.filter((c) => c.statut === "DEMANDE" && !aSaisir.includes(c));
  const termines = page.comptages.filter((c) => c.statut !== "DEMANDE").sort((a, b) => (b.saisiLe ?? b.createdAt).localeCompare(a.saisiLe ?? a.createdAt));
  const peutDemander = peutDemanderDesComptages(f) || page.peutFaireCompter.length > 0;

  return (
    <div className="space-y-4">
      {peutDemander && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => ctx.ouvrir({ type: "demanderComptage" })}>Demander un comptage</Button>
          <Button size="sm" variant="outline" onClick={() => ctx.ouvrir({ type: "planifierComptage" })}>Planifier un comptage régulier</Button>
        </div>
      )}

      <Section
        titre="À compter"
        compte={aSaisir.length}
        aide="Comptez ce que vous avez réellement en main, article par article — « 0 » compris. Chaque écart avec le registre est corrigé, et le comptage le dit."
      >
        {aSaisir.length === 0 ? <Vide>Aucun comptage ne vous est demandé.</Vide> : (
          <ul className="space-y-2">
            {aSaisir.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-foreground">
                    {c.holderId === null ? "Le magasin central" : "Votre stock"} — {libelleFamilleComptage(c.famille)}
                    {c.enRetard && <Badge tone="danger" className="ml-2 align-middle">En retard</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Demandé par {nomDe(page, c.demandeurId)} le {date(c.createdAt)} · à saisir avant le {jour(c.echeance)}
                    {c.recurrenceId ? " · comptage régulier" : ""}
                    {c.note ? ` · « ${c.note} »` : ""}
                  </p>
                </div>
                <Button size="sm" onClick={() => setSaisie(c)} className="h-10 w-full sm:h-8 sm:w-auto">Saisir le comptage</Button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {enCours.length > 0 && (
        <Section titre="Comptages en attente" compte={enCours.length} aide="Demandés, pas encore saisis par la personne qui détient le matériel.">
          <ul className="space-y-2">
            {enCours.map((c) => (
              <li key={c.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium text-foreground">
                    {quiCompte(page, c)} — {libelleFamilleComptage(c.famille)}
                    {c.enRetard && <Badge tone="danger" className="ml-2 align-middle">En retard</Badge>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Demandé par {nomDe(page, c.demandeurId)} le {date(c.createdAt)} · attendu le {jour(c.echeance)}
                  </p>
                </div>
                {peutAnnulerComptage(f, c.demandeurId) && (
                  <Button size="sm" variant="ghost" onClick={() => ctx.ouvrir({ type: "annulerComptage", comptage: c })}>Annuler</Button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {page.recurrences.length > 0 && (
        <Section titre="Comptages réguliers" compte={page.recurrences.filter((r) => r.actif).length}>
          <ul className="space-y-2">
            {page.recurrences.map((r) => <LigneRecurrence key={r.id} r={r} ctx={ctx} />)}
          </ul>
        </Section>
      )}

      <Section titre="Derniers comptages" aide={`Les comptages saisis ou annulés depuis 90 jours — ce que le registre attendait, ce qui a été compté, l'écart corrigé.`}>
        {termines.length === 0 ? <Vide>Aucun comptage récent.</Vide> : (
          <ul className="space-y-2">{termines.map((c) => <LigneResultat key={c.id} c={c} page={page} peutCorriger={c.statut === "SAISI" && peutSaisirComptage(f, c.holderId)} />)}</ul>
        )}
      </Section>

      {saisie && <FormulaireSaisie comptage={saisie} page={page} onClose={() => setSaisie(null)} onSucces={ctx.annoncer} />}
    </div>
  );
}

function LigneRecurrence({ r, ctx }: { r: RecurrenceVue; ctx: Ctx }) {
  const { page, f } = ctx;
  const gere = peutGererRecurrence(f, r.auteurId);
  const qui = r.cible === "PERSONNE" ? nomDe(page, r.holderId) : CIBLE_COMPTAGE_LABEL[r.cible];
  return (
    <li className={cn("flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between", !r.actif && "bg-secondary/40")}>
      <div className="min-w-0">
        <p className="break-words text-sm font-medium text-foreground">
          {qui} — {libelleFamilleComptage(r.famille)} · {FREQUENCE_COMPTAGE_LABEL[r.frequence].toLowerCase()}
          {!r.actif && <Badge tone="warning" className="ml-2 align-middle">Suspendu</Badge>}
        </p>
        <p className="text-xs text-muted-foreground">
          {r.actif ? `Prochain le ${jour(r.prochaineLe)}` : r.pauseMotif ?? "Suspendu"}
          {` · ${r.delaiJours} jour(s) pour compter · ${r.nbDeclenchements} déclenchement(s)`}
          {r.auteurId && r.auteurId !== f.userId ? ` · posé par ${nomDe(page, r.auteurId)}` : ""}
        </p>
      </div>
      {gere && (
        <div className="flex flex-wrap gap-1.5">
          {r.actif ? (
            <Button size="sm" variant="outline" disabled={ctx.occupe}
              onClick={() => ctx.executer(() => suspendreRecurrenceComptage(fd({ recurrenceId: r.id })), "Récurrence suspendue.")}>Suspendre</Button>
          ) : (
            <Button size="sm" variant="outline" disabled={ctx.occupe}
              onClick={() => ctx.executer(() => reprendreRecurrenceComptage(fd({ recurrenceId: r.id })), "Récurrence reprise.")}>Reprendre</Button>
          )}
          <Button size="sm" variant="ghost" disabled={ctx.occupe}
            onClick={() => ctx.executer(() => supprimerRecurrenceComptage(fd({ recurrenceId: r.id })), "Récurrence supprimée.")}>Supprimer</Button>
        </div>
      )}
    </li>
  );
}

function LigneResultat({ c, page, peutCorriger }: { c: ComptageVue; page: PageStock; peutCorriger: boolean }) {
  const [ouvert, setOuvert] = React.useState(false);
  const [correction, setCorrection] = React.useState(false);
  const ecarts = c.lignes.filter((l) => l.ecart !== 0);
  return (
    <li className="rounded-lg border border-border">
      <button type="button" onClick={() => setOuvert(!ouvert)} aria-expanded={ouvert} disabled={c.lignes.length === 0}
        className="flex w-full flex-col gap-1 p-3 text-left sm:flex-row sm:items-center sm:justify-between">
        <span className="flex min-w-0 items-start gap-2">
          {c.lignes.length > 0 && (ouvert ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />)}
          <span className="min-w-0">
            <span className="block break-words text-sm font-medium text-foreground">
              {quiCompte(page, c)} — {libelleFamilleComptage(c.famille)}
              <Badge tone={TON_STATUT[c.statut]} className="ml-2 align-middle">{STATUT_COMPTAGE_LABEL[c.statut]}</Badge>
            </span>
            <span className="block text-xs text-muted-foreground">
              {c.statut === "SAISI"
                ? `Compté le ${date(c.saisiLe)}${c.saisiParId && c.saisiParId !== c.holderId ? ` par ${nomDe(page, c.saisiParId)}` : ""} · ${c.lignes.length} article(s) · ${ecarts.length} écart(s)`
                : `Annulé${c.annuleMotif ? ` : « ${c.annuleMotif} »` : ""}`}
            </span>
          </span>
        </span>
      </button>
      {ouvert && (
        <div className="border-t border-border px-3 py-2">
          <Table className="min-w-[480px]">
            <TableHeader>
              <TableRow>
                <TableHead>Article</TableHead>
                <TableHead className="text-right">Registre</TableHead>
                <TableHead className="text-right">Compté</TableHead>
                <TableHead className="text-right">Écart</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {c.lignes.map((l) => (
                <TableRow key={l.itemId}>
                  <TableCell data-sans-etiquette className="font-medium sm:py-1.5 sm:font-normal"><span className="w-full">{l.libelle}</span></TableCell>
                  <TableCell className="text-right tabular-nums sm:py-1.5">{nombre(l.attendu)}</TableCell>
                  <TableCell className="text-right tabular-nums sm:py-1.5">{nombre(l.compte)}</TableCell>
                  <TableCell className={cn("text-right tabular-nums sm:py-1.5", l.ecart < 0 ? "text-destructive" : l.ecart > 0 ? "text-success" : "text-muted-foreground")}>
                    {l.ecart > 0 ? "+" : ""}{nombre(l.ecart)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {c.corrigeLe && (
            <p className="mt-2 text-xs text-muted-foreground">
              Corrigé le {date(c.corrigeLe)}{c.corrigeParId ? ` par ${nomDe(page, c.corrigeParId)}` : ""}{c.corrigeMotif ? ` : « ${c.corrigeMotif} »` : ""}.
            </p>
          )}
          {peutCorriger && !correction && (
            <Button size="sm" variant="outline" className="mt-2 w-full sm:w-auto" onClick={() => setCorrection(true)}>Corriger ce comptage</Button>
          )}
          {peutCorriger && correction && <FormulaireCorrection c={c} onClose={() => setCorrection(false)} />}
        </div>
      )}
    </li>
  );
}

/**
 * CORRIGER UN COMPTAGE SAISI (audit 360°, R19) — « 40 » tapé pour « 14 ». Pré-rempli avec ce qui a été
 * compté (ici, c'est une CORRECTION, pas une saisie à l'aveugle) ; seules les lignes changées partent,
 * avec le motif, exigé. L'écart corrigé s'applique au solde du jour : des sorties ont pu avoir lieu.
 */
function FormulaireCorrection({ c, onClose }: { c: ComptageVue; onClose: () => void }) {
  const { enCours, rafraichir } = useRafraichir();
  const [valeurs, setValeurs] = React.useState<Record<string, string>>(() => Object.fromEntries(c.lignes.map((l) => [l.itemId, String(l.compte)])));
  const [motif, setMotif] = React.useState("");
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [annonce, setAnnonce] = React.useState<string | null>(null);
  const [occupe, setOccupe] = React.useState(false);
  const changees = c.lignes.filter((l) => (valeurs[l.itemId] ?? "").trim() !== "" && Number((valeurs[l.itemId] ?? "").replace(",", ".")) !== l.compte);

  const envoyer = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setOccupe(true); setErreur(null);
    const fd = new FormData();
    fd.set("comptageId", c.id);
    for (const l of changees) { fd.append("itemId", l.itemId); fd.append("compte", valeurs[l.itemId] ?? ""); }
    fd.set("motif", motif);
    try {
      const r = await corrigerComptage(fd);
      if (r.ok) { setAnnonce(r.message ?? "Comptage corrigé."); rafraichir(); }
      else setErreur(r.error ?? "La correction n'a pas été enregistrée.");
    } catch {
      setErreur("La correction n'a pas abouti (connexion ou serveur). Rechargez la page avant de recommencer : elle a pu s'enregistrer malgré tout.");
    } finally {
      setOccupe(false);
    }
  };

  if (annonce) {
    return (
      <div className="mt-2 space-y-2">
        <p role="status" className="rounded-lg bg-success/10 px-3 py-2 text-sm">{annonce}</p>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={enCours}>Fermer</Button>
      </div>
    );
  }
  return (
    <form onSubmit={envoyer} className="mt-2 space-y-2 rounded-lg border border-border p-3">
      <ul className="space-y-1.5">
        {c.lignes.map((l) => (
          <li key={l.itemId} className="flex items-center justify-between gap-2">
            <label htmlFor={`corr-${c.id}-${l.itemId}`} className="min-w-0 break-words text-sm">{l.libelle}</label>
            <Input id={`corr-${c.id}-${l.itemId}`} inputMode="decimal" className="w-24 shrink-0 text-right" value={valeurs[l.itemId] ?? ""}
              onChange={(e) => setValeurs({ ...valeurs, [l.itemId]: e.target.value })} />
          </li>
        ))}
      </ul>
      <Label htmlFor={`corr-motif-${c.id}`}>Pourquoi vous corrigez</Label>
      <Textarea id={`corr-motif-${c.id}`} value={motif} onChange={(e) => setMotif(e.target.value)} rows={2} placeholder="Ex. 40 saisi au lieu de 14 pour les fiches posologiques." />
      {erreur && <p role="alert" className="text-sm text-destructive">{erreur}</p>}
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" size="sm" className="h-10 sm:h-8" disabled={occupe || enCours || changees.length === 0 || !motif.trim()}>Enregistrer la correction</Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose} disabled={occupe}>Annuler</Button>
      </div>
    </form>
  );
}

/**
 * LA SAISIE D'UN COMPTAGE — une ligne par article que le registre attribue au détenteur, rien de
 * pré-rempli : « tout est juste » ne doit pas être un clic, sinon le comptage recopie le registre
 * au lieu de le vérifier. Un article TROUVÉ (que le registre ne lui attribue pas) s'ajoute.
 */
function FormulaireSaisie({ comptage, page, onClose, onSucces }: {
  comptage: ComptageVue;
  page: PageStock;
  onClose: () => void;
  /** Le résumé de l'action (« 3 article(s) comptés, 1 écart(s) corrigé(s)… ») : un comptage qui se
   *  fermerait sans rien dire laisserait la personne chercher ce qui a été corrigé. */
  onSucces: (texte: string) => void;
}) {
  const { rafraichir } = useRafraichir();
  const { attendus, ajoutables } = React.useMemo(() => partitionComptage(
    page.articles.map((a) => ({ itemId: a.id, famille: a.catalogue.famille, actif: a.isActive, solde: quantiteDe(a, comptage.holderId) })),
    comptage.famille,
  ), [page.articles, comptage]);
  const parId = React.useMemo(() => new Map(page.articles.map((a) => [a.id, a])), [page.articles]);
  const [trouves, setTrouves] = React.useState<string[]>([]);
  const [choix, setChoix] = React.useState("");
  const [erreur, setErreur] = React.useState<string | null>(null);
  const [occupe, setOccupe] = React.useState(false);
  const proposables = ajoutables.filter((id) => !trouves.includes(id));
  const lignes = [...attendus, ...trouves];

  const envoyer = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setOccupe(true);
    setErreur(null);
    try {
      const r = await saisirComptage(new FormData(e.currentTarget));
      if (r.ok) { onSucces(r.message ?? "Comptage enregistré."); rafraichir(); onClose(); }
      else setErreur(r.error ?? "Le comptage n'a pas été enregistré.");
    } catch {
      setErreur("Le comptage n'a pas abouti (connexion ou serveur). Rechargez la page avant de recommencer : il a pu s'enregistrer malgré tout.");
    } finally {
      setOccupe(false);
    }
  };

  return (
    <Sheet open onClose={onClose} width="lg"
      title={comptage.holderId === null ? "Compter le magasin central" : "Compter mon stock"}
      description={`${libelleFamilleComptage(comptage.famille)} — demandé par ${nomDe(page, comptage.demandeurId)}, à saisir avant le ${jour(comptage.echeance)}. Indiquez ce que vous avez réellement en main.`}
    >
      <form onSubmit={envoyer} className="space-y-4">
        <input type="hidden" name="comptageId" value={comptage.id} />
        {lignes.length === 0 ? (
          <Vide>Le registre ne vous attribue aucun article de cette famille. Si vous en avez trouvé, ajoutez-les ci-dessous.</Vide>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {lignes.map((id) => {
              const a = parId.get(id);
              const trouve = trouves.includes(id);
              return (
                <li key={id} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-foreground">{a?.libelle ?? "Article"}</p>
                    <p className="text-xs text-muted-foreground">
                      {a?.catalogue.reference}{a && !a.isActive ? " · archivé" : ""}{trouve ? " · trouvé (absent du registre)" : ""}
                    </p>
                  </div>
                  {/* Au téléphone, le champ prend la largeur : on compte debout, au pouce. */}
                  <div className="flex w-full items-center gap-2 sm:w-auto">
                    <input type="hidden" name="itemId" value={id} />
                    <Input
                      type="number" name="compte" min={0} step="any" required inputMode="decimal"
                      aria-label={`Quantité comptée — ${a?.libelle ?? "article"}`} className="h-11 min-w-0 flex-1 text-right sm:h-10 sm:w-28 sm:flex-none"
                    />
                    <span className="w-14 shrink-0 text-xs text-muted-foreground">{a?.catalogue.unite}</span>
                    {trouve && (
                      <button type="button" aria-label="Retirer cet article trouvé" onClick={() => setTrouves(trouves.filter((x) => x !== id))}
                        className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-secondary hover:text-foreground sm:h-7 sm:w-7">
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}

        {proposables.length > 0 && (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <label className="flex-1 space-y-1 text-sm">
              <span className="text-xs font-medium text-muted-foreground">Un article que vous avez, absent de la liste</span>
              <Select value={choix} onChange={(e) => setChoix(e.target.value)} aria-label="Article trouvé">
                <option value="">Choisir l&apos;article</option>
                {proposables.map((id) => <option key={id} value={id}>{parId.get(id)?.libelle ?? "Article"}</option>)}
              </Select>
            </label>
            <Button type="button" size="sm" variant="outline" disabled={!choix} className="h-10 w-full sm:h-10 sm:w-auto"
              onClick={() => { if (choix) { setTrouves([...trouves, choix]); setChoix(""); } }}>
              <Plus className="mr-1 h-4 w-4" aria-hidden /> Ajouter
            </Button>
          </div>
        )}

        <label className="block space-y-1 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Note (facultative)</span>
          <Textarea name="note" rows={2} placeholder="Carton abîmé, fiches retrouvées dans la voiture…" />
        </label>

        {erreur && (
          <p role="alert" className="flex items-start gap-2 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {erreur}
          </p>
        )}

        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:justify-end">
          <Button type="button" variant="ghost" onClick={onClose}>Fermer</Button>
          <Button type="submit" disabled={occupe || lignes.length === 0}>{occupe ? "Enregistrement…" : "Enregistrer le comptage"}</Button>
        </div>
      </form>
    </Sheet>
  );
}
