"use client";

import * as React from "react";
import { ChevronDown, ChevronRight, ExternalLink, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input, Select } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { SuperAdminDeleteButton } from "@/components/shared/super-admin-delete";
import { cn } from "@/lib/utils";
import { FAMILLES, FAMILLE_LABEL, type PromoFamille } from "@/lib/promo/catalogue";
import { MOVEMENT_LABEL, NATURE_TRANSFERT_LABEL, stockLevel } from "@/lib/promo/stock";
import {
  peutAnnulerDemande, peutAnnulerTransfert, peutConfirmerReception, peutCorriger, peutDeclarerPerte, peutDemander, peutDoter,
  peutEntrerAlaMain, peutGererArticles, peutPoserOuverture, peutServirDemande, peutSortirDe, type FaitsStock,
} from "@/lib/promo/stock-acces";
import { STATUT_REFONTE_LABEL, peutProposerRefonte } from "@/lib/promo/comptages";
import type { ActionResult } from "@/lib/actions/types";
import type { ArticleVue, DemandeVue, MouvementVue, PageStock, SupportVue, TransfertVue } from "@/lib/queries/promo-stock";
import { annulerDemande, confirmerReception } from "@/lib/actions/promo-stock-actions";
import {
  BadgeFamille, BadgeNiveau, BadgeValidite, Chiffre, LotsDuDetenteur, Section, TitreArticle, Vide,
  date, depuis, distribuable, enLotPerime, jour, nombre, nomDe, quantiteDe, soldeDe,
} from "./stock-commun";
import type { Dialogue } from "./stock-formulaires";

/**
 * LES QUATRE VUES DU STOCK — chacune répond à UNE question, et ne montre que ce que la personne a
 * le droit de voir (le chargeur ne lui a envoyé que cela) :
 *
 *   • « Mon stock »    — qu'est-ce que j'ai en main, qu'est-ce qui arrive, qu'ai-je à confirmer ?
 *   • « Mon équipe »   — qu'ont en main les personnes sous moi ? (le directeur des opérations le gère)
 *   • « Magasin »      — que reste-t-il au magasin central, qui attend quoi ?
 *   • « Vue générale » — où est chaque unité de l'entreprise, magasin, personnes et route compris ?
 *
 * Chaque bouton est montré APRÈS avoir interrogé la règle pure (`promo/stock-acces.ts`), celle
 * que l'action relit : un bouton que l'action refuse n'est pas un bouton (§118.71).
 */

export interface Ctx {
  page: PageStock;
  f: FaitsStock;
  ouvrir: (d: Dialogue) => void;
  executer: (fn: () => Promise<ActionResult>, succes: string) => Promise<void>;
  /** Le bandeau de l'écran, pour un formulaire qui appelle son action lui-même (la saisie d'un comptage). */
  annoncer: (texte: string) => void;
  occupe: boolean;
}

const fd = (entrees: Record<string, string>): FormData => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entrees)) f.set(k, v);
  return f;
};

// ─────────────────────────────── BRIQUES PARTAGÉES ───────────────────────────────

/** Une réception à confirmer — l'attestation « je l'ai entre les mains » ne se donne qu'ici. */
function CarteReception({ t, ctx }: { t: TransfertVue; ctx: Ctx }) {
  const { page, f } = ctx;
  const peut = peutConfirmerReception(f, t.versId);
  return (
    <li className="rounded-lg border border-border p-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="break-words font-medium text-foreground">{nombre(t.quantite)} × {t.libelle}</p>
          <p className="text-xs text-muted-foreground">
            {NATURE_TRANSFERT_LABEL[t.nature]} · de {nomDe(page, t.deId)} · envoyé {depuis(t.createdAt, page.maintenant)}
            {t.initiateurId !== t.deId && t.deId !== null ? ` · à l'initiative de ${nomDe(page, t.initiateurId)}` : ""}
          </p>
          {t.note && <p className="mt-1 break-words text-sm text-foreground">« {t.note} »</p>}
        </div>
        {peut ? (
          // Au téléphone, trois gros boutons empilés : la réception se confirme au pouce, debout.
          <div className="grid shrink-0 grid-cols-1 gap-2 sm:flex sm:flex-wrap">
            <Button
              size="sm" variant="success" disabled={ctx.occupe} className="h-10 sm:h-8"
              onClick={() => ctx.executer(() => confirmerReception(fd({ transfertId: t.id })), `${nombre(t.quantite)} reçues.`)}
            >
              J&apos;ai tout reçu
            </Button>
            <Button size="sm" variant="outline" onClick={() => ctx.ouvrir({ type: "recuEnPartie", transfert: t })}>Reçu en partie</Button>
            <Button size="sm" variant="ghost" onClick={() => ctx.ouvrir({ type: "refuserReception", transfert: t })}>Refuser</Button>
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">Le destinataire confirme la réception.</span>
        )}
      </div>
    </li>
  );
}

/** Un transfert encore en route, vu de celui qui l'a lancé (ou de qui le surveille). */
function LigneEnRoute({ t, ctx }: { t: TransfertVue; ctx: Ctx }) {
  const { page, f } = ctx;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="break-words text-sm font-medium text-foreground">{nombre(t.quantite)} × {t.libelle}</p>
        <p className="text-xs text-muted-foreground">
          {NATURE_TRANSFERT_LABEL[t.nature]} · {nomDe(page, t.deId)} → {nomDe(page, t.versId)} · {depuis(t.createdAt, page.maintenant)} · en attente de confirmation
        </p>
      </div>
      {peutAnnulerTransfert(f, t) && (
        <Button size="sm" variant="ghost" onClick={() => ctx.ouvrir({ type: "annulerTransfert", transfert: t })}>Annuler</Button>
      )}
    </li>
  );
}

const TON_DEMANDE = { OUVERTE: "info", SERVIE: "success", REFUSEE: "danger", ANNULEE: "neutral" } as const;
const LIBELLE_DEMANDE = { OUVERTE: "En attente", SERVIE: "Servie", REFUSEE: "Refusée", ANNULEE: "Annulée" } as const;

function LigneDemande({ d, ctx, avecDemandeur = false, servir = false }: { d: DemandeVue; ctx: Ctx; avecDemandeur?: boolean; servir?: boolean }) {
  const { page, f } = ctx;
  return (
    <li className="flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <p className="break-words text-sm font-medium text-foreground">
          {nombre(d.quantite)} × {d.libelle}
          <Badge tone={TON_DEMANDE[d.statut]} className="ml-2 align-middle">{LIBELLE_DEMANDE[d.statut]}</Badge>
        </p>
        <p className="text-xs text-muted-foreground">
          {avecDemandeur ? `${nomDe(page, d.demandeurId)} · ` : ""}demandé le {date(d.createdAt)}
          {d.note ? ` · « ${d.note} »` : ""}
          {d.noteDecision && d.statut !== "OUVERTE" ? ` · réponse : « ${d.noteDecision} »` : ""}
        </p>
      </div>
      {d.statut === "OUVERTE" && (
        <div className="flex flex-wrap gap-2">
          {servir && peutServirDemande(f) && (
            <>
              <Button size="sm" onClick={() => ctx.ouvrir({ type: "servir", demande: d })}>Servir</Button>
              <Button size="sm" variant="ghost" onClick={() => ctx.ouvrir({ type: "refuserDemande", demande: d })}>Refuser</Button>
            </>
          )}
          {peutAnnulerDemande(f, d.demandeurId) && (
            <Button
              size="sm" variant="ghost" disabled={ctx.occupe}
              onClick={() => ctx.executer(() => annulerDemande(fd({ demandeId: d.id })), "Demande annulée.")}
            >
              Annuler ma demande
            </Button>
          )}
        </div>
      )}
    </li>
  );
}

/** Les gestes sur le stock d'un détenteur — chacun montré seulement si la règle l'ouvre. */
function GestesDuDetenteur({ a, detenteurId, ctx }: { a: ArticleVue; detenteurId: string | null; ctx: Ctx }) {
  const { f } = ctx;
  const dispo = distribuable(a, detenteurId);
  const tenu = quantiteDe(a, detenteurId);
  const boutons: React.ReactNode[] = [];
  if (detenteurId === null) {
    if (peutDoter(f) && a.isActive) {
      const rien = dispo <= 0 ? "Rien de distribuable au magasin (hors lots périmés)" : undefined;
      boutons.push(
        <Button key="doter" size="sm" disabled={dispo <= 0} title={rien}
          onClick={() => ctx.ouvrir({ type: "doter", article: a })}>Doter</Button>,
        // RÉPARTIR (Direction, 23/11/2026) : la même règle que « Doter », entre plusieurs personnes à la fois.
        <Button key="repartir" size="sm" variant="outline" disabled={dispo <= 0} title={rien ?? "Une quantité par personne, envoyée en une fois"}
          onClick={() => ctx.ouvrir({ type: "repartir", article: a })}>Répartir</Button>,
      );
    }
  } else if (peutSortirDe(f, detenteurId) && a.isActive) {
    boutons.push(
      <Button key="tr" size="sm" variant="outline" disabled={dispo <= 0} title={dispo <= 0 ? "Rien de distribuable (hors lots périmés)" : undefined}
        onClick={() => ctx.ouvrir({ type: "transferer", article: a, deId: detenteurId, retour: false })}>Transférer</Button>,
      <Button key="ret" size="sm" variant="outline" disabled={dispo <= 0} title={dispo <= 0 ? "Rien de distribuable (hors lots périmés)" : undefined}
        onClick={() => ctx.ouvrir({ type: "transferer", article: a, deId: detenteurId, retour: true })}>Rendre au magasin</Button>,
    );
  }
  if (peutDeclarerPerte(f, detenteurId) && tenu > 0) {
    boutons.push(<Button key="perte" size="sm" variant="ghost" onClick={() => ctx.ouvrir({ type: "perte", article: a, detenteurId })}>Perte</Button>);
  }
  if (peutCorriger(f, detenteurId)) {
    boutons.push(<Button key="corr" size="sm" variant="ghost" onClick={() => ctx.ouvrir({ type: "corriger", article: a, detenteurId })}>Corriger</Button>);
  }
  if (!boutons.length) return null;
  return <div className="flex flex-wrap gap-2 sm:gap-1.5">{boutons}</div>;
}

/**
 * PROPOSER LA REFONTE d'un support DURABLE (§118.168) — montré seulement si la règle l'ouvre, et
 * jamais en double : une proposition déjà ouverte par la personne le dit au lieu de proposer.
 */
function BoutonRefonte({ a, ctx }: { a: ArticleVue; ctx: Ctx }) {
  const { page, f } = ctx;
  if (!a.isActive || !peutProposerRefonte(f, a.catalogue.famille)) return null;
  const ouverte = page.refontes.some((r) => r.itemId === a.id && r.auteurId === page.moi && r.statut === "OUVERTE");
  if (ouverte) return <span className="text-xs text-muted-foreground">Refonte proposée</span>;
  return <Button size="sm" variant="ghost" onClick={() => ctx.ouvrir({ type: "proposerRefonte", article: a })}>Proposer une refonte</Button>;
}

function ListeSupports({ supports, ctx }: { supports: SupportVue[]; ctx: Ctx }) {
  const { f } = ctx;
  if (!supports.length) return <Vide>Aucun support numérique déclaré.</Vide>;
  return (
    <ul className="space-y-2">
      {supports.map((s) => (
        <li key={s.id} className={cn("flex flex-col gap-2 rounded-lg border border-border p-3 sm:flex-row sm:items-center sm:justify-between", !s.isActive && "opacity-60")}>
          <div className="min-w-0">
            <p className="break-words font-medium text-foreground">{s.libelle}</p>
            <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              {s.catalogue.reference}
              {!s.isActive && <Badge>Archivé</Badge>}
              <BadgeValidite etat={s.etat} fin={s.valableJusquau} />
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {s.lien ? (
              <a href={s.lien} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-9 items-center gap-1 px-1 text-sm text-primary hover:underline sm:min-h-0 sm:px-0">
                Ouvrir <ExternalLink className="h-3.5 w-3.5" />
              </a>
            ) : <span className="text-xs text-muted-foreground">Pas de lien</span>}
            {peutGererArticles(f) && (
              <Button size="sm" variant="ghost" onClick={() => ctx.ouvrir({ type: "ficheSupport", support: s })}>Fiche</Button>
            )}
            <SuperAdminDeleteButton kind="PROMO_STOCK_ITEM" id={s.id} name={s.libelle} enabled={f.superAdmin || f.module.supprimer === true} compact stay />
          </div>
        </li>
      ))}
    </ul>
  );
}

/** Le filtre commun au magasin et à la vue générale — par texte, famille, société. */
interface Filtre { q: string; famille: string; societe: string }

function filtrer(articles: ArticleVue[], fl: Filtre): ArticleVue[] {
  const q = fl.q.trim().toLowerCase();
  return articles.filter((a) =>
    (!q || `${a.libelle} ${a.catalogue.reference} ${a.location ?? ""}`.toLowerCase().includes(q))
    && (!fl.famille || a.catalogue.famille === fl.famille)
    && (!fl.societe || (a.companyId ?? "") === fl.societe));
}

function BarreFiltre({ fl, setFl, articles }: { fl: Filtre; setFl: (f: Filtre) => void; articles: ArticleVue[] }) {
  const societes = [...new Map(articles.filter((a) => a.companyId).map((a) => [a.companyId as string, a.societe ?? "Société"])).entries()];
  const familles = FAMILLES.filter((x) => x !== "NUMERIQUE" && articles.some((a) => a.catalogue.famille === x));
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <div className="relative flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={fl.q} onChange={(e) => setFl({ ...fl, q: e.target.value })} placeholder="Rechercher un article, une référence…" className="pl-8" aria-label="Rechercher un article" />
      </div>
      {familles.length > 1 && (
        <Select value={fl.famille} onChange={(e) => setFl({ ...fl, famille: e.target.value })} aria-label="Famille" className="sm:w-44">
          <option value="">Toutes les familles</option>
          {familles.map((x) => <option key={x} value={x}>{FAMILLE_LABEL[x as PromoFamille]}</option>)}
        </Select>
      )}
      {societes.length > 1 && (
        <Select value={fl.societe} onChange={(e) => setFl({ ...fl, societe: e.target.value })} aria-label="Société" className="sm:w-48">
          <option value="">Toutes les sociétés</option>
          {societes.map(([id, nom]) => <option key={id} value={id}>{nom}</option>)}
        </Select>
      )}
    </div>
  );
}

function JournalArticle({ a, mouvements, ctx }: { a: ArticleVue; mouvements: MouvementVue[]; ctx: Ctx }) {
  const { page } = ctx;
  if (!mouvements.length) return <p className="text-xs text-muted-foreground">Aucun mouvement.</p>;
  // Une ligne = un mouvement : au téléphone, une carte par mouvement plutôt qu'un tableau à faire glisser.
  return (
    <Table className="min-w-[640px]">
      <TableHeader>
        <TableRow>
          <TableHead>Date</TableHead>
          <TableHead>Mouvement</TableHead>
          <TableHead>Chez</TableHead>
          <TableHead className="text-right">Quantité</TableHead>
          <TableHead>Motif</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {mouvements.map((m) => (
          <TableRow key={m.id} className={cn(m.annule && "text-muted-foreground line-through decoration-muted-foreground/60")}>
            {/* Intitulés écrits en toutes lettres : ce journal s'affiche aussi DANS le tableau de la vue
                générale, dont le témoin d'intitulés poserait sinon les siens sur ces cellules. */}
            <TableCell label="Date" className="whitespace-nowrap sm:py-1.5">{date(m.occurredAt)}</TableCell>
            <TableCell label="Mouvement" className="sm:py-1.5"><span>{MOVEMENT_LABEL[m.kind]} <span className="text-xs text-muted-foreground">· lot {m.lotNumero}</span></span></TableCell>
            <TableCell label="Chez" className="sm:py-1.5">{nomDe(page, m.detenteurId)}</TableCell>
            <TableCell label="Quantité" className={cn("whitespace-nowrap text-right tabular-nums sm:py-1.5", m.delta > 0 ? "text-success" : "text-destructive")}>
              {m.delta > 0 ? "+" : ""}{nombre(m.delta)}
            </TableCell>
            <TableCell label="Motif" className="text-xs text-muted-foreground sm:py-1.5">
              {m.motif ?? "—"}{m.par ? ` · par ${nomDe(page, m.par)}` : ""}
            </TableCell>
            <TableCell data-sans-etiquette className="text-right sm:py-1.5">
              {m.annulable && (
                <Button size="sm" variant="ghost" onClick={() => ctx.ouvrir({ type: "annulerMouvement", article: a, mouvement: m })}>Annuler</Button>
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ─────────────────────────────── MON STOCK ───────────────────────────────

export function VueMoi({ ctx }: { ctx: Ctx }) {
  const { page, f } = ctx;
  const moi = page.moi;
  const aConfirmer = page.transferts.filter((t) => t.statut === "EN_ROUTE" && t.versId === moi);
  const enMain = page.articles.filter((a) => quantiteDe(a, moi) !== 0);
  const envoyes = page.transferts.filter((t) => t.statut === "EN_ROUTE" && t.versId !== moi && (t.deId === moi || t.initiateurId === moi));
  const demandes = page.demandes.filter((d) => d.demandeurId === moi);
  const supports = page.supports.filter((s) => s.isActive && s.etat !== "PERIME");
  const mesRefontes = page.refontes.filter((r) => r.auteurId === moi);
  const historique = page.articles
    .flatMap((a) => a.journal.filter((m) => m.detenteurId === moi).map((m) => ({ a, m })))
    .sort((x, y) => y.m.occurredAt.localeCompare(x.m.occurredAt))
    .slice(0, 15);

  return (
    <div className="space-y-4">
      {aConfirmer.length > 0 && (
        <Section titre="À confirmer" compte={aConfirmer.length} aide="Ce matériel vous est envoyé. Il n'entre dans votre stock qu'à votre confirmation — et seul vous pouvez la donner.">
          <ul className="space-y-2">{aConfirmer.map((t) => <CarteReception key={t.id} t={t} ctx={ctx} />)}</ul>
        </Section>
      )}

      <Section titre="Mon matériel" aide="Ce que vous avez en main, lot par lot — le plus tôt périmé part en premier.">
        {enMain.length === 0 ? (
          <Vide>Vous n&apos;avez aucun matériel en main. Une dotation du magasin apparaît ici après votre confirmation.</Vide>
        ) : (
          <ul className="space-y-2">
            {enMain.map((a) => {
              const perime = enLotPerime(a, moi);
              return (
                <li key={a.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <TitreArticle a={a} />
                    <LotsDuDetenteur a={a} detenteurId={moi} />
                    {perime > 0 && (
                      <p className="mt-1 text-xs text-destructive">{nombre(perime)} dans un lot périmé : elles ne se remettent plus — déclarez-les détruites (Perte).</p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-xl font-semibold tabular-nums text-foreground">
                      {nombre(quantiteDe(a, moi))} <span className="text-xs font-normal text-muted-foreground">{a.catalogue.unite}</span>
                    </span>
                    <GestesDuDetenteur a={a} detenteurId={moi} ctx={ctx} />
                    <BoutonRefonte a={a} ctx={ctx} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {envoyes.length > 0 && (
        <Section titre="Envoyé, en attente de confirmation" compte={envoyes.length} aide="Parti de votre stock (ou lancé par vous) ; le destinataire ne l'a pas encore confirmé.">
          <ul className="space-y-2">{envoyes.map((t) => <LigneEnRoute key={t.id} t={t} ctx={ctx} />)}</ul>
        </Section>
      )}

      <Section
        titre="Mes demandes au magasin"
        actions={peutDemander(f) && page.demandables.length > 0
          ? <Button size="sm" onClick={() => ctx.ouvrir({ type: "demander" })}>Demander du matériel</Button>
          : undefined}
      >
        {demandes.length === 0 ? (
          <Vide>Aucune demande récente.</Vide>
        ) : (
          <ul className="space-y-2">{demandes.map((d) => <LigneDemande key={d.id} d={d} ctx={ctx} />)}</ul>
        )}
      </Section>

      {supports.length > 0 && (
        <Section titre="Supports numériques en vigueur" aide="E-flyers, vidéos, e-ADV : un lien, pas de quantité.">
          <ListeSupports supports={supports} ctx={ctx} />
        </Section>
      )}

      {mesRefontes.length > 0 && (
        <Section titre="Mes propositions de refonte" aide="La Direction Marketing les retient ou les écarte ; sa réponse s'affiche ici.">
          <ul className="space-y-1.5 text-sm">
            {mesRefontes.map((r) => (
              <li key={r.id} className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0 break-words">{r.libelle} <span className="text-xs text-muted-foreground">· « {r.motif} »</span></span>
                <span className="shrink-0 text-xs text-muted-foreground">
                  <Badge tone={r.statut === "RETENUE" ? "success" : r.statut === "ECARTEE" ? "neutral" : "info"}>{STATUT_REFONTE_LABEL[r.statut]}</Badge>
                  {r.noteDecision ? ` « ${r.noteDecision} »` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {historique.length > 0 && (
        <Section titre="Mes derniers mouvements">
          <ul className="divide-y divide-border text-sm">
            {historique.map(({ a, m }) => (
              <li key={m.id} className={cn("flex flex-wrap items-baseline justify-between gap-2 py-1.5", m.annule && "text-muted-foreground line-through")}>
                <span className="min-w-0 break-words">{date(m.occurredAt)} · {MOVEMENT_LABEL[m.kind]} · {a.libelle}</span>
                <span className={cn("tabular-nums", m.delta > 0 ? "text-success" : "text-destructive")}>{m.delta > 0 ? "+" : ""}{nombre(m.delta)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

// ─────────────────────────────── MON ÉQUIPE ───────────────────────────────

export function VueEquipe({ ctx }: { ctx: Ctx }) {
  const { page, f } = ctx;
  const gere = f.directeurDesOperations && (f.superAdmin || f.module.modifier);
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {gere
          ? "Vous gérez le matériel de vos équipes : le déplacer d'une personne à l'autre, le prendre, ou le rendre au magasin. Celui qui reçoit confirme toujours la réception, et celui dont le stock est touché en est prévenu."
          : "Vous voyez le stock des personnes sous vous. Sa gestion revient au directeur des opérations ; chacun gère son propre matériel."}
      </p>
      {page.equipe.length === 0 ? <Vide>Personne sous vous.</Vide> : page.equipe.map((m) => <CarteMembre key={m.id} membre={m} ctx={ctx} />)}
    </div>
  );
}

function CarteMembre({ membre, ctx }: { membre: { id: string; nom: string }; ctx: Ctx }) {
  const { page } = ctx;
  const articles = page.articles.filter((a) => quantiteDe(a, membre.id) !== 0);
  const versLui = page.transferts.filter((t) => t.statut === "EN_ROUTE" && t.versId === membre.id);
  const deLui = page.transferts.filter((t) => t.statut === "EN_ROUTE" && t.deId === membre.id);
  const demandes = page.demandes.filter((d) => d.demandeurId === membre.id && d.statut === "OUVERTE");
  const unites = articles.reduce((t, a) => t + quantiteDe(a, membre.id), 0);
  const [ouvert, setOuvert] = React.useState(false);
  const enAttente = versLui.length + deLui.length + demandes.length;

  return (
    <div className="surface">
      <button type="button" onClick={() => setOuvert(!ouvert)} aria-expanded={ouvert}
        className="flex w-full flex-col items-start gap-1 px-3 py-3 text-left sm:flex-row sm:items-center sm:justify-between sm:gap-3 sm:px-4">
        <span className="flex w-full min-w-0 items-center gap-2 sm:w-auto">
          {ouvert ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <span className="truncate font-medium text-foreground">{membre.nom}</span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5 pl-6 text-xs text-muted-foreground sm:shrink-0 sm:justify-end sm:pl-0">
          <span>{articles.length} article(s) · {nombre(unites)} unité(s)</span>
          {enAttente > 0 && <Badge tone="info">{enAttente} en cours</Badge>}
        </span>
      </button>
      {ouvert && (
        <div className="space-y-3 border-t border-border px-3 py-3 sm:px-4">
          {articles.length === 0 ? <Vide>Aucun matériel en main.</Vide> : (
            <ul className="space-y-2">
              {articles.map((a) => (
                <li key={a.id} className="flex flex-col gap-2 rounded-lg border border-border p-3 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0">
                    <TitreArticle a={a} />
                    <LotsDuDetenteur a={a} detenteurId={membre.id} />
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="text-lg font-semibold tabular-nums">{nombre(quantiteDe(a, membre.id))} <span className="text-xs font-normal text-muted-foreground">{a.catalogue.unite}</span></span>
                    <GestesDuDetenteur a={a} detenteurId={membre.id} ctx={ctx} />
                  </div>
                </li>
              ))}
            </ul>
          )}
          {versLui.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">En route vers {membre.nom}</p>
              <ul className="space-y-2">{versLui.map((t) => <LigneEnRoute key={t.id} t={t} ctx={ctx} />)}</ul>
            </div>
          )}
          {deLui.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Parti de chez {membre.nom}, non encore confirmé</p>
              <ul className="space-y-2">{deLui.map((t) => <LigneEnRoute key={t.id} t={t} ctx={ctx} />)}</ul>
            </div>
          )}
          {demandes.length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-muted-foreground">Demandes ouvertes au magasin</p>
              <ul className="space-y-2">{demandes.map((d) => <LigneDemande key={d.id} d={d} ctx={ctx} />)}</ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────── MAGASIN ───────────────────────────────

export function VueMagasin({ ctx }: { ctx: Ctx }) {
  const { page, f } = ctx;
  const [fl, setFl] = React.useState<Filtre>({ q: "", famille: "", societe: "" });
  const [archives, setArchives] = React.useState(false);
  const [ouvert, setOuvert] = React.useState<string | null>(null);

  const actifs = page.articles.filter((a) => a.isActive);
  const archivesListe = page.articles.filter((a) => !a.isActive);
  const auMagasin = actifs.reduce((t, a) => t + quantiteDe(a, null), 0);
  const bas = actifs.filter((a) => stockLevel(quantiteDe(a, null), a.alertThreshold) === "LOW").length;
  const rupture = actifs.filter((a) => stockLevel(quantiteDe(a, null), a.alertThreshold) === "OUT").length;
  const perimes = actifs.reduce((t, a) => t + enLotPerime(a, null), 0);
  const enRoute = page.transferts.filter((t) => t.statut === "EN_ROUTE" && (t.deId === null || t.versId === null)).reduce((t, x) => t + x.quantite, 0);

  const demandesOuvertes = page.demandes.filter((d) => d.statut === "OUVERTE");
  const retours = page.transferts.filter((t) => t.statut === "EN_ROUTE" && t.versId === null);
  const dotations = page.transferts.filter((t) => t.statut === "EN_ROUTE" && t.deId === null);
  const liste = filtrer(archives ? page.articles : actifs, fl);

  const gestes = [
    peutEntrerAlaMain(f) && <Button key="e" size="sm" onClick={() => ctx.ouvrir({ type: "entrer" })}>Entrée manuelle</Button>,
    peutPoserOuverture(f) && <Button key="o" size="sm" variant="outline" onClick={() => ctx.ouvrir({ type: "ouverture" })}>Inventaire d&apos;ouverture</Button>,
    peutGererArticles(f) && <Button key="s" size="sm" variant="outline" onClick={() => ctx.ouvrir({ type: "support" })}>Support numérique</Button>,
  ].filter(Boolean);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Chiffre label="Articles suivis" valeur={nombre(actifs.length)} />
        <Chiffre label="Unités au magasin" valeur={nombre(auMagasin)} ton="info" />
        <Chiffre label="Sous le seuil" valeur={nombre(bas)} ton={bas > 0 ? "alerte" : "neutre"} />
        <Chiffre label="Rupture au magasin" valeur={nombre(rupture)} ton={rupture > 0 ? "danger" : "neutre"} />
        <Chiffre label="En route" valeur={nombre(enRoute)} aide="Dotations parties du magasin et retours vers lui, non encore confirmés." />
        <Chiffre label="En lot périmé" valeur={nombre(perimes)} ton={perimes > 0 ? "danger" : "neutre"} aide="Unités au magasin dans un lot dont la validité est passée : elles ne se distribuent plus." />
      </div>

      {gestes.length > 0 && <div className="flex flex-wrap gap-2">{gestes}</div>}

      {demandesOuvertes.length > 0 && (
        <Section titre="Demandes à servir" compte={demandesOuvertes.length} aide="Servir envoie une dotation ; le demandeur confirme à réception.">
          <ul className="space-y-2">{demandesOuvertes.map((d) => <LigneDemande key={d.id} d={d} ctx={ctx} avecDemandeur servir />)}</ul>
        </Section>
      )}

      {retours.length > 0 && (
        <Section titre="Retours à confirmer" compte={retours.length} aide="Du matériel revient au magasin : il n'y entre qu'à la confirmation de la gestionnaire du magasin.">
          <ul className="space-y-2">{retours.map((t) => <CarteReception key={t.id} t={t} ctx={ctx} />)}</ul>
        </Section>
      )}

      {dotations.length > 0 && (
        <Section titre="Dotations en route" compte={dotations.length} aide="Parties du magasin, pas encore confirmées par la personne dotée.">
          <ul className="space-y-2">{dotations.map((t) => <LigneEnRoute key={t.id} t={t} ctx={ctx} />)}</ul>
        </Section>
      )}

      {/* LE MATÉRIEL SORTI POUR DES ÉVÉNEMENTS (§118.167) : réservé à l'accord d'un poste Ad & Pro, il a
          quitté le solde du magasin sans être chez personne. Sans cette liste, il disparaîtrait des
          chiffres sans qu'on sache où il est — la confirmation se fait sur la fiche de la demande. */}
      {page.horsMagasin.length > 0 && (
        <Section
          titre="Sorti pour des événements"
          compte={page.horsMagasin.length}
          aide="Réservé à l'accord d'un poste « Matériel du stock » d'une demande Ad & Pro. Après l'événement, la demande confirme ce qui a été remis, et le reste revient ici."
        >
          <ul className="divide-y divide-border rounded-lg border border-border">
            {page.horsMagasin.map((h) => (
              <li key={h.ligneId} className="flex flex-col gap-1 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                <span className="min-w-0 break-words">
                  <strong className="tabular-nums">{nombre(h.quantite)}</strong> {h.libelle}
                  {h.depuis && <span className="text-xs text-muted-foreground"> · depuis le {date(h.depuis)}</span>}
                </span>
                <a href={h.lien} className="inline-flex min-h-9 shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline sm:min-h-0">
                  {h.demande} <ExternalLink className="h-3 w-3" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section
        titre="Articles au magasin"
        actions={archivesListe.length > 0 ? (
          <label className="flex min-h-9 items-center gap-2 text-xs text-muted-foreground sm:min-h-0">
            <input type="checkbox" checked={archives} onChange={(e) => setArchives(e.target.checked)} className="h-4 w-4 rounded border-input" />
            Afficher les archivés ({archivesListe.length})
          </label>
        ) : undefined}
      >
        <BarreFiltre fl={fl} setFl={setFl} articles={page.articles} />
        {liste.length === 0 ? (
          <Vide>{page.articles.length === 0 ? "Aucun article en stock. Le premier se crée par une entrée manuelle ou un inventaire d'ouverture (la gestionnaire du magasin ou le Super Admin), ou à la réception d'un achat." : "Aucun article ne correspond au filtre."}</Vide>
        ) : (
          <ul className="space-y-2">
            {liste.map((a) => {
              const q = quantiteDe(a, null);
              const deplie = ouvert === a.id;
              return (
                <li key={a.id} className={cn("rounded-lg border border-border", !a.isActive && "opacity-70")}>
                  <div className="flex flex-col gap-2 p-3 lg:flex-row lg:items-center lg:justify-between">
                    <button type="button" onClick={() => setOuvert(deplie ? null : a.id)} aria-expanded={deplie} className="flex min-w-0 items-start gap-2 text-left">
                      {deplie ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />}
                      <TitreArticle a={a} />
                    </button>
                    <div className="flex flex-wrap items-center gap-2">
                      <BadgeFamille famille={a.catalogue.famille} />
                      {a.isActive ? <BadgeNiveau quantite={q} seuil={a.alertThreshold} /> : <Badge>Archivé</Badge>}
                      <span className="text-lg font-semibold tabular-nums">{nombre(q)} <span className="text-xs font-normal text-muted-foreground">{a.catalogue.unite}</span></span>
                      {a.enRoute > 0 && <span className="text-xs text-muted-foreground">+ {nombre(a.enRoute)} en route</span>}
                      <GestesDuDetenteur a={a} detenteurId={null} ctx={ctx} />
                      {peutGererArticles(f) && <Button size="sm" variant="ghost" onClick={() => ctx.ouvrir({ type: "fiche", article: a })}>Fiche</Button>}
                      <BoutonRefonte a={a} ctx={ctx} />
                    </div>
                  </div>
                  {deplie && <DetailArticle a={a} ctx={ctx} detenteurId={null} />}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      <Section titre="Supports numériques" compte={page.supports.filter((s) => s.isActive).length}>
        <ListeSupports supports={page.supports} ctx={ctx} />
      </Section>
    </div>
  );
}

/** Le détail d'un article : ses lots, ses produits, ses notes, son journal (au périmètre demandé). */
function DetailArticle({ a, ctx, detenteurId }: { a: ArticleVue; ctx: Ctx; detenteurId: string | null | "tous" }) {
  const { f } = ctx;
  const mouvements = detenteurId === "tous" ? a.journal : a.journal.filter((m) => m.detenteurId === detenteurId);
  const soldeMagasin = soldeDe(a, null);
  const auLot = new Map((soldeMagasin?.parLot ?? []).map((p) => [p.lotId, p.quantite]));
  return (
    <div className="space-y-4 border-t border-border px-3 py-3">
      {a.produits.length > 0 && <p className="text-xs text-muted-foreground">Produit(s) : {a.produits.map((p) => p.nom).join(", ")}</p>}
      {a.notes && <p className="whitespace-pre-wrap text-sm text-foreground">{a.notes}</p>}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Lots</p>
        {a.lots.length === 0 ? <p className="text-xs text-muted-foreground">Aucun lot.</p> : (
          <Table className="min-w-[600px]">
            <TableHeader>
              <TableRow>
                <TableHead>Lot</TableHead>
                <TableHead>Reçu le</TableHead>
                <TableHead>Coût unitaire</TableHead>
                <TableHead>Validité</TableHead>
                <TableHead className="text-right">Au magasin</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {a.lots.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="sm:py-1.5"><span>{l.numero}{l.libelle ? <span className="text-xs text-muted-foreground"> · {l.libelle}</span> : null}</span></TableCell>
                  <TableCell className="whitespace-nowrap sm:py-1.5">{jour(l.recuLe)}</TableCell>
                  <TableCell className="whitespace-nowrap tabular-nums sm:py-1.5">{l.coutUnitaire == null ? "—" : `${nombre(l.coutUnitaire)} DZD`}</TableCell>
                  <TableCell className="sm:py-1.5">{l.etat === "SANS_DATE" ? "—" : <BadgeValidite etat={l.etat} fin={l.valableJusquau} />}</TableCell>
                  <TableCell className="text-right tabular-nums sm:py-1.5">{nombre(auLot.get(l.id) ?? 0)}</TableCell>
                  <TableCell className="text-right sm:py-1.5">
                    {peutGererArticles(f) && <Button size="sm" variant="ghost" onClick={() => ctx.ouvrir({ type: "lot", article: a, lot: l })}>Modifier</Button>}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">
          Journal{detenteurId === null ? " du magasin" : ""}
          {a.journalNonAffiche > 0 ? ` — les ${a.journal.length} derniers mouvements visibles ; ${nombre(a.journalNonAffiche)} plus anciens ne sont pas affichés` : ""}
        </p>
        <JournalArticle a={a} mouvements={mouvements} ctx={ctx} />
      </div>
      <SuperAdminDeleteButton kind="PROMO_STOCK_ITEM" id={a.id} name={a.libelle} enabled={f.superAdmin || f.module.supprimer === true} label="Supprimer l'article" stay />
    </div>
  );
}

// ─────────────────────────────── VUE GÉNÉRALE ───────────────────────────────

export function VueGenerale({ ctx }: { ctx: Ctx }) {
  const { page } = ctx;
  const [fl, setFl] = React.useState<Filtre>({ q: "", famille: "", societe: "" });
  const [ouvert, setOuvert] = React.useState<string | null>(null);
  const actifs = page.articles.filter((a) => a.isActive);
  const liste = filtrer(actifs, fl);

  const total = (a: ArticleVue) => (a.total ?? 0) + a.enRoute;
  const magasin = actifs.reduce((t, a) => t + quantiteDe(a, null), 0);
  const personnes = actifs.reduce((t, a) => t + a.soldes.filter((s) => s.detenteurId !== null).reduce((u, s) => u + s.quantite, 0), 0);
  const route = actifs.reduce((t, a) => t + a.enRoute, 0);
  const perimes = actifs.reduce((t, a) => t + a.soldes.reduce((u, s) => u + enLotPerime(a, s.detenteurId), 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        <Chiffre label="Parc total" valeur={nombre(magasin + personnes + route)} ton="info" aide="Magasin + personnes + en route : chaque unité de l'entreprise, comptée une fois." />
        <Chiffre label="Au magasin" valeur={nombre(magasin)} />
        <Chiffre label="Chez les personnes" valeur={nombre(personnes)} />
        <Chiffre label="En route" valeur={nombre(route)} aide="Parti de chez quelqu'un, pas encore confirmé par celui qui reçoit." />
        <Chiffre label="En lot périmé" valeur={nombre(perimes)} ton={perimes > 0 ? "danger" : "neutre"} aide="Unités encore en main dans un lot dont la validité est passée — à déclarer détruites." />
      </div>
      <BarreFiltre fl={fl} setFl={setFl} articles={actifs} />
      {liste.length === 0 ? <Vide>Aucun article ne correspond.</Vide> : (
        // Une ligne = un article : une carte au téléphone ; le détail déplié suit la carte de son article.
        <Table className="min-w-[760px]">
          <TableHeader>
            <TableRow>
              <TableHead>Article</TableHead>
              <TableHead className="text-right">Parc</TableHead>
              <TableHead className="text-right">Magasin</TableHead>
              <TableHead className="text-right">Personnes</TableHead>
              <TableHead className="text-right">En route</TableHead>
              <TableHead>État au magasin</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {liste.map((a) => {
              const chezPersonnes = a.soldes.filter((s) => s.detenteurId !== null && s.quantite !== 0);
              const deplie = ouvert === a.id;
              return (
                <React.Fragment key={a.id}>
                  <TableRow className="align-top">
                    <TableCell data-sans-etiquette className="align-top sm:py-2">
                      <button type="button" onClick={() => setOuvert(deplie ? null : a.id)} aria-expanded={deplie} className="flex w-full min-w-0 items-start gap-2 text-left">
                        {deplie ? <ChevronDown className="mt-0.5 h-4 w-4 shrink-0" /> : <ChevronRight className="mt-0.5 h-4 w-4 shrink-0" />}
                        <TitreArticle a={a} />
                      </button>
                    </TableCell>
                    <TableCell className="align-top text-right font-semibold tabular-nums sm:py-2">{nombre(total(a))}</TableCell>
                    <TableCell className="align-top text-right tabular-nums sm:py-2">{nombre(quantiteDe(a, null))}</TableCell>
                    <TableCell className="align-top text-right tabular-nums sm:py-2"><span>{nombre(chezPersonnes.reduce((t, s) => t + s.quantite, 0))} <span className="text-xs text-muted-foreground">({chezPersonnes.length})</span></span></TableCell>
                    <TableCell className="align-top text-right tabular-nums sm:py-2">{nombre(a.enRoute)}</TableCell>
                    <TableCell className="align-top sm:py-2"><BadgeNiveau quantite={quantiteDe(a, null)} seuil={a.alertThreshold} /></TableCell>
                  </TableRow>
                  {deplie && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={6} data-sans-etiquette className="sm:pb-3 sm:pt-0">
                        <div className="w-full min-w-0">
                          <RepartitionArticle a={a} ctx={ctx} />
                        </div>
                      </TableCell>
                    </TableRow>
                  )}
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

/** Où sont les unités d'un article : magasin, puis chaque personne — avec les gestes que la règle ouvre. */
function RepartitionArticle({ a, ctx }: { a: ArticleVue; ctx: Ctx }) {
  const { page } = ctx;
  const detenteurs = [...a.soldes]
    .filter((s) => s.quantite !== 0 || s.detenteurId === null)
    .sort((x, y) => (x.detenteurId === null ? -1 : y.detenteurId === null ? 1 : nomDe(page, x.detenteurId).localeCompare(nomDe(page, y.detenteurId), "fr")));
  return (
    <div className="space-y-2 rounded-lg bg-secondary/40 p-3">
      {detenteurs.length === 0 && <p className="text-xs text-muted-foreground">Aucune unité au registre.</p>}
      <ul className="space-y-2">
        {detenteurs.map((s) => (
          <li key={s.detenteurId ?? "magasin"} className="flex flex-col gap-2 rounded-md border border-border bg-card p-2.5 lg:flex-row lg:items-center lg:justify-between">
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">{nomDe(page, s.detenteurId)}</p>
              <LotsDuDetenteur a={a} detenteurId={s.detenteurId} />
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-semibold tabular-nums">{nombre(s.quantite)} <span className="text-xs font-normal text-muted-foreground">{a.catalogue.unite}</span></span>
              <GestesDuDetenteur a={a} detenteurId={s.detenteurId} ctx={ctx} />
            </div>
          </li>
        ))}
      </ul>
      <details className="text-sm">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Journal de l&apos;article</summary>
        <div className="mt-2"><JournalArticle a={a} mouvements={a.journal} ctx={ctx} /></div>
        {a.journalNonAffiche > 0 && (
          <p className="mt-1 text-xs text-muted-foreground">{nombre(a.journalNonAffiche)} mouvement(s) plus ancien(s) ne sont pas affichés.</p>
        )}
      </details>
    </div>
  );
}
