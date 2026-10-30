"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { WorkspaceBlocks, WorkspaceAskProvider } from "@/platform/ia/ecrans/blocks";
import { TurnWorkspaceView } from "./turn-workspace";
import { SCENARIOS } from "./scenarios";
import { PLANCHE_GODMODE } from "./planche-godmode";
import { PLANCHE_VIZ } from "./planche-viz";
import { composeTurn } from "@/lib/assistant/workspace/turn";
import type { WorkspaceComposition } from "@/platform/ia/workspace/protocol";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LA PLANCHE DE RENDU — et pourquoi elle N'EXISTE PAS en production.
 *
 * ── LE PROBLÈME ──────────────────────────────────────────────────────────────────────────
 *
 * Les blocs de l'espace de travail ne s'affichent qu'au bout d'un vrai tour de conversation :
 * une question, un appel de modèle, une lecture canonique. On ne peut donc PAS les
 * photographier dans un test automatisé — l'E2E de ce projet tourne sans aucun appel IA, et
 * c'est une bonne chose.
 *
 * Sans planche, la revue visuelle exigée par la mission (« regarde les captures, ne te contente
 * pas des tests qui passent ») ne pourrait porter que sur l'écran d'accueil vide.
 *
 * ── LA RÈGLE QU'ON NE VIOLE PAS ──────────────────────────────────────────────────────────
 *
 * « Aucune donnée simulée » est une règle de PRODUIT : jamais un chiffre inventé présenté au
 * PDG comme un fait. Cette planche contient des valeurs de démonstration — elle ne doit donc
 * JAMAIS être atteignable par lui.
 *
 * D'où la garde, posée par la PAGE qui l'affiche : sans `ADAM_BLOCK_PREVIEW=1` dans
 * l'environnement du serveur, elle n'est jamais rendue. Cette variable n'est posée que par la
 * configuration Playwright, le temps d'une revue.
 *
 * ── POURQUOI PAS UNE ROUTE À ELLE ────────────────────────────────────────────────────────
 *
 * Une page `/chief-of-staff/apercu-blocs` aurait dû refaire elle-même le contrôle de droits —
 * donc importer `@/lib/session`, donc franchir la frontière Adam ↔ ERP une fois de plus. Le
 * cliquet de `src/platform/boundary.test.ts` a refusé, et il avait raison : la planche n'a
 * aucun besoin d'une porte à elle. Affichée DEPUIS le bureau d'Adam, elle hérite exactement
 * des gardes du bureau — authentification, module `CHIEF_OF_STAFF` — sans en réécrire une.
 *
 * Les valeurs choisies sont VOLONTAIREMENT reconnaissables comme telles (« Démo », références
 * en `DEMO-…`) : une planche de rendu qui ressemble à de vraies données finit tôt ou tard
 * recopiée dans une réunion.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const PLANCHE: { titre: string; composition: WorkspaceComposition }[] = [
  {
    titre: "Fiche d'une personne — « Montre-moi Raihana »",
    composition: {
      source: "directory_lookup",
      blocks: [{
        kind: "people",
        title: "Démo Benkaci",
        people: [{
          nom: "Démo Benkaci",
          poste: "Affaires réglementaires",
          entite: "Démo Pharma",
          statut: { label: "Active", ton: "succes" },
          coordonnees: [
            { canal: "e-mail", valeur: "demo.benkaci@exemple.test", usage: "professionnel", fiabilite: "vérifiée en interne", principale: true },
            { canal: "téléphone", valeur: "+213 555 00 00 00", fiabilite: "compte / fiche ERP" },
          ],
          metriques: [
            { valeur: "12", label: "Dossiers assignés" },
            { valeur: "3", label: "En retard", ton: "alerte" },
            { valeur: "75 %", label: "Dans les délais", ton: "attention" },
          ],
        }],
        actions: [
          { libelle: "Ses dossiers en retard", phrase: "Montre les dossiers en retard de Démo Benkaci, dans un tableau", ton: "primaire" },
          { libelle: "Écrire", phrase: "Prépare un mail à Démo Benkaci" },
        ],
      }],
    },
  },
  {
    titre: "Tableau actionnable — « Ses dossiers en retard ? »",
    composition: {
      source: "regulatory_workload",
      blocks: [{
        kind: "table",
        title: "Dossiers en retard — Démo Benkaci",
        columns: [
          { key: "reference", label: "Dossier" },
          { key: "produit", label: "Produit" },
          { key: "retard", label: "Retard", badge: true },
          { key: "etape", label: "Étape actuelle" },
        ],
        rows: [
          { cells: { reference: "DEMO-2026-015", produit: "Molécule A", retard: "4 jours", etape: "Évaluation" }, tons: { retard: "alerte" }, href: "/regulatory", actions: [{ libelle: "Ouvrir", phrase: "Ouvre DEMO-2026-015" }] },
          { cells: { reference: "DEMO-2026-008", produit: "Molécule B", retard: "2 jours", etape: "Dossier technique" }, tons: { retard: "alerte" }, href: "/regulatory", actions: [{ libelle: "Ouvrir", phrase: "Ouvre DEMO-2026-008" }] },
          { cells: { reference: "DEMO-2026-022", produit: "Molécule C", retard: "1 jour", etape: "Revue interne" }, tons: { retard: "alerte" }, href: "/regulatory", actions: [{ libelle: "Ouvrir", phrase: "Ouvre DEMO-2026-022" }] },
        ],
        total: 3,
        actions: [{ libelle: "Voir tous ses dossiers (12)", phrase: "Montre tous les dossiers de Démo Benkaci, dans un tableau" }],
      }],
    },
  },
  {
    titre: "Dossier — « Ouvre DEMO-2026-015 »",
    composition: {
      source: "inspect_record",
      blocks: [{
        kind: "dossier",
        title: "DEMO-2026-015",
        subtitle: "Molécule A",
        badge: { label: "En retard", ton: "alerte" },
        fields: [
          { label: "Chargé du dossier", value: "Démo Benkaci" },
          { label: "Étape courante", value: "Évaluation" },
          { label: "Retard", value: "4 jours" },
          { label: "Échéance", value: "22/08/2026" },
        ],
        steps: [
          { label: "Préparation", etat: "fait" },
          { label: "Soumission", etat: "fait" },
          { label: "Évaluation", etat: "courant" },
          { label: "Décision", etat: "a-venir" },
          { label: "Enregistrement", etat: "a-venir" },
        ],
        alerte: { label: "Échéance dépassée de 4 jours — bloqué à l'étape « Évaluation ».", ton: "alerte" },
        docs: [
          { nom: "Dossier_technique.pdf", href: "/api/documents/demo-1", type: "pdf", taille: "1,2 Mo" },
          { nom: "Donnees_stabilite.xlsx", href: "/api/documents/demo-2", type: "feuille", taille: "320 ko" },
          { nom: "Lettre_accompagnement.docx", href: "/api/documents/demo-3", type: "autre", taille: "245 ko" },
        ],
        participants: [
          { nom: "Démo Benkaci", poste: "Chargée du dossier", coordonnees: [] },
          { nom: "Démo Amrani", poste: "Affaires réglementaires", coordonnees: [] },
        ],
        activite: [
          { date: "18/08/2026", label: "Démo Benkaci a déposé Donnees_stabilite.xlsx" },
          { date: "15/08/2026", label: "Démo Amrani a commenté la section 3.2" },
          { date: "14/08/2026", label: "Informations complémentaires demandées" },
        ],
        href: "/regulatory",
        actions: [
          { libelle: "Relancer", phrase: "Prépare un mail de relance pour DEMO-2026-015", ton: "primaire" },
          { libelle: "Assigner", phrase: "Réassigne DEMO-2026-015" },
          { libelle: "Faire avancer", phrase: "Avance l'étape de DEMO-2026-015" },
        ],
      }],
    },
  },
  {
    titre: "Message prêt — « Prépare une relance »",
    composition: {
      source: "gmail_prepare_mail",
      blocks: [{
        kind: "email",
        title: "Message prêt",
        a: ["contact@exemple.test"],
        objet: "Relance — dossier DEMO-2026-015 (Molécule A)",
        corps: "Madame, Monsieur,\n\nNous nous permettons de vous relancer concernant le dossier DEMO-2026-015 soumis le 20/07/2026. Nous restons à votre disposition pour toute information complémentaire.\n\nCordialement,\nDémo Benkaci",
        statut: "brouillon",
        actions: [
          { libelle: "Envoyer", phrase: "Envoie", ton: "primaire" },
          { libelle: "Modifier", phrase: "Reprends ce message" },
          { libelle: "Annuler", phrase: "Annule ce message", ton: "danger" },
        ],
      }],
    },
  },
  {
    titre: "Décisions — on tranche depuis la conversation",
    composition: {
      source: "list_pending_decisions",
      blocks: [{
        kind: "queue",
        title: "En attente de votre décision",
        total: 2,
        items: [
          {
            titre: "Devis imprimeur — 1 850 000 DZD", detail: "Demandé par Démo Amrani",
            statut: "À valider", echeance: "2026-08-28", href: "/validations",
            actions: [
              { libelle: "Approuver", phrase: "Approuve la validation DEMO-VAL-014", ton: "primaire" },
              { libelle: "Refuser", phrase: "Refuse la validation DEMO-VAL-014", ton: "danger" },
            ],
          },
          { titre: "Congé — Démo Khaled", detail: "5 j", statut: "En attente du validateur précédent", echeance: "2026-09-02", href: "/validations" },
        ],
      }],
    },
  },
  {
    titre: "Progression — « Il reste combien ? »",
    composition: {
      source: "read_budget",
      blocks: [{
        kind: "progress",
        title: "Consommation des enveloppes",
        gauges: [
          { label: "Démo Ad & Pro", valeur: 2_660_000, total: 3_000_000, unite: "DZD", detail: "reste 340 000 DZD", ton: "attention" },
          { label: "Démo Formation", valeur: 120_000, total: 900_000, unite: "DZD", detail: "reste 780 000 DZD", ton: "neutre" },
          { label: "Démo Congrès", valeur: 1_120_000, total: 1_000_000, unite: "DZD", detail: "dépassement de 120 000 DZD", ton: "alerte" },
        ],
      }],
    },
  },
  {
    titre: "Document — « Montre le moi ici »",
    composition: {
      source: "show_document",
      blocks: [{
        kind: "document",
        title: "Aperçu du fichier",
        docs: [{
          nom: "Export_Regulatory.xlsx",
          href: "/api/documents/demo-2",
          type: "feuille",
          taille: "320 ko",
          feuille: {
            columns: [
              { key: "c0", label: "Référence" },
              { key: "c1", label: "Produit" },
              { key: "c2", label: "Statut" },
            ],
            rows: [
              { c0: "DEMO-2026-015", c1: "Molécule A", c2: "Évaluation" },
              { c0: "DEMO-2026-008", c1: "Molécule B", c2: "Dossier technique" },
              { c0: "DEMO-2026-022", c1: "Molécule C", c2: "Revue interne" },
            ],
            total: 69,
          },
        }],
      }],
    },
  },
];

/**
 * LE FOURNISSEUR D'ACTION DE LA PLANCHE.
 *
 * Sans fournisseur, `ActionRow` n'affiche RIEN — c'est voulu : un bouton qui n'envoie nulle part
 * est pire que pas de bouton. La planche doit donc en poser un, sinon elle photographierait des
 * cartes amputées de la moitié de ce qu'on veut juger.
 *
 * Ce qu'il fait est le geste HONNÊTE : il n'exécute pas la phrase, il l'emporte dans la vraie
 * conversation (`?q=…`, pré-remplie et non envoyée). Un clic depuis une planche de démonstration
 * ne doit rien déclencher — mais il ne doit pas non plus mentir en ne faisant rien du tout.
 */
export function BlockPreviewPlanche() {
  const router = useRouter();
  const ask = React.useCallback(
    (phrase: string) => router.push(`/chief-of-staff?q=${encodeURIComponent(phrase)}`),
    [router],
  );

  return (
    <div className="chief-scroll flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-[var(--chief-workspace-max)] px-4 py-8 sm:px-6">
        <p className="mb-6 text-[12.5px]" style={{ color: "hsl(var(--chief-text-tertiary))" }}>
          Planche de rendu — valeurs de démonstration, hors production.
        </p>
        <WorkspaceAskProvider ask={ask}>
          {/*
            ── LES CINQ SCÉNARIOS D'ACCEPTATION (§22) ─────────────────────────────────────
            Ils passent par `composeTurn` puis `TurnWorkspaceView`, exactement comme la
            production. Ce qui est photographié ici EST le rendu réel : si l'objet ne passait pas
            avant la prose, ou si le bouton n'atterrissait pas sous son objet, cela se verrait ici
            avant de se voir chez le PDG.
          */}
          <div className="flex flex-col gap-12" data-testid="scenarios">
            {SCENARIOS.map((sc, i) => {
              const turn = composeTurn({
                compositions: sc.compositions,
                proposals: sc.proposals ?? null,
                trace: sc.trace ?? null,
                reply: sc.reply ?? null,
              });
              return (
                <section key={sc.question} data-scenario={String(i + 1)}>
                  <p className="chief-user-turn mb-1 inline-block">{sc.question}</p>
                  <p className="mb-3 text-[11.5px]" style={{ color: "hsl(var(--chief-text-tertiary))" }}>
                    Attendu — {sc.attendu}
                  </p>
                  <TurnWorkspaceView
                    turn={turn}
                    renderProposals={(idx) => (
                      // La planche montre les gestes comme des LIGNES, pas comme des cartes de
                      // confirmation : elle ne peut rien exécuter, et un bouton « Confirmer » qui
                      // ne confirmerait rien serait un mensonge d'interface.
                      <div className="chief-preview-actions" data-testid="scenario-actions">
                        {idx.map((n) => {
                          const pr = sc.proposals?.[n];
                          return pr ? <span key={n} className="chief-chip">{pr.title}</span> : null;
                        })}
                      </div>
                    )}
                    renderBundle={() => (
                      <div className="chief-preview-bundle" data-testid="scenario-bundle">
                        {turn.pending} actions préparées — une seule confirmation.
                      </div>
                    )}
                  />
                </section>
              );
            })}
          </div>

          {/* ── LE CATALOGUE DES BLOCS. Il reste : c'est la revue par TYPE, complémentaire de
                 la revue par SCÉNARIO ci-dessus. ─────────────────────────────────────────── */}
          <h2 className="mb-4 mt-14 text-[13px] font-semibold" style={{ color: "hsl(var(--chief-text-secondary))" }}>
            Catalogue des blocs
          </h2>
          <div className="flex flex-col gap-10">
            {[...PLANCHE_GODMODE, ...PLANCHE_VIZ, ...PLANCHE].map((p) => (
              <section key={p.titre} data-planche={p.composition.blocks[0].kind}>
                <h3 className="mb-2 text-[13px] font-semibold" style={{ color: "hsl(var(--chief-text-secondary))" }}>
                  {p.titre}
                </h3>
                <WorkspaceBlocks composition={p.composition} />
              </section>
            ))}
          </div>
        </WorkspaceAskProvider>
      </div>
    </div>
  );
}
