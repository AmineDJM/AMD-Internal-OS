"use client";

import type { VueStockPromo } from "@/lib/chemins/stock-promo";
import * as React from "react";
import { useRafraichir } from "@/components/shared/use-rafraichir";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { aUneEquipe, peutConfirmerReception, peutServirDemande, peutVoirStockDe, tientLeMagasin } from "@/lib/promo/stock-acces";
import { peutDeciderRefonte, peutDemanderDesComptages, peutSaisirComptage, peutVoirTableauDeBord } from "@/lib/promo/comptages";
import type { ActionResult } from "@/lib/actions/types";
import type { PageStock } from "@/lib/queries/promo-stock";
import { faitsDe } from "./stock-commun";
import { FormulaireStock, type Dialogue } from "./stock-formulaires";
import { VueEquipe, VueGenerale, VueMagasin, VueMoi, type Ctx } from "./stock-vues";
import { VueMedecins } from "./stock-medecins";
import { VueComptages } from "./stock-comptages";
import { VueTableau } from "./stock-tableau";

// Les vues sont celles que les notifications et les liens désignent (`?vue=…`) : une seule liste,
// au socle avec l'adresse (§118.173) — une vue ajoutée ici sans y être ne serait atteignable par
// aucun lien, et l'escale de l'ancienne adresse la jetterait.
type Vue = VueStockPromo;

const LIBELLE_VUE: Record<Vue, string> = {
  moi: "Mon stock",
  equipe: "Mon équipe",
  magasin: "Magasin",
  general: "Vue générale",
  comptages: "Comptages",
  tableau: "Tableau de bord",
  medecins: "Remis aux médecins",
};

/**
 * LE STOCK PROMOTIONNEL — l'écran. Il ne calcule aucun droit : il reçoit les FAITS de la personne
 * et appelle les prédicats purs que les actions relisent. Il n'affiche aucune vue que la règle ne
 * lui ouvre pas — le chargeur, lui, ne lui a même pas ENVOYÉ ce qu'elle ne peut pas voir.
 */
export function StockEcran({ page, vueDemandee }: { page: PageStock; vueDemandee: string | null }) {
  const { rafraichir } = useRafraichir();
  const f = React.useMemo(() => faitsDe(page), [page]);

  const visibles = React.useMemo(() => {
    const v: Vue[] = ["moi"];
    if (aUneEquipe(f)) v.push("equipe");
    if (peutVoirStockDe(f, null)) v.push("magasin");
    if (f.superAdmin || f.vueGlobale) v.push("general");
    // LES COMPTAGES (§118.168) : pour qui en a à saisir, en a demandé, ou peut en demander.
    if (page.comptages.length > 0 || page.recurrences.length > 0 || peutDemanderDesComptages(f) || page.peutFaireCompter.length > 0) v.push("comptages");
    // LE TABLEAU DE BORD : la Direction Marketing, la vue globale, le Super Admin — la règle, pas un rôle.
    if (peutVoirTableauDeBord(f) && page.tableau) v.push("tableau");
    // L'HISTORIQUE PAR MÉDECIN est ouvert à qui a le module : le chargeur ne lui a envoyé que les
    // remises des détenteurs qu'il voit (§118.166) — un délégué y lit les siennes.
    v.push("medecins");
    return v;
  }, [f, page]);

  const aConfirmer = page.transferts.filter((t) => t.statut === "EN_ROUTE" && t.versId === page.moi).length;
  const pourLeMagasin = (peutServirDemande(f) ? page.demandes.filter((d) => d.statut === "OUVERTE").length : 0)
    + (peutConfirmerReception(f, null) ? page.transferts.filter((t) => t.statut === "EN_ROUTE" && t.versId === null).length : 0);
  const aCompter = page.comptages.filter((c) => c.statut === "DEMANDE" && peutSaisirComptage(f, c.holderId)).length;
  const pourLeTableau = (page.tableau?.alertes.length ?? 0) + (peutDeciderRefonte(f) ? page.refontes.filter((r) => r.statut === "OUVERTE").length : 0);

  // La vue d'arrivée : ce que l'adresse demande si la règle l'ouvre ; sinon ce qui attend la
  // personne d'abord — une réception à confirmer passe avant tout, puis le métier de chacun.
  const [vue, setVue] = React.useState<Vue>(() => {
    if (vueDemandee && (visibles as string[]).includes(vueDemandee)) return vueDemandee as Vue;
    if (aConfirmer > 0) return "moi";
    if (aCompter > 0) return "comptages";
    if (tientLeMagasin(f) && visibles.includes("magasin")) return "magasin";
    if (visibles.includes("general")) return "general";
    if (visibles.includes("equipe")) return "equipe";
    return "moi";
  });
  const choisir = (v: Vue) => {
    setVue(v);
    // L'adresse suit la vue (lien partageable, retour arrière) sans recharger la page.
    window.history.replaceState(null, "", `?vue=${v}`);
  };

  const [dialogue, setDialogue] = React.useState<Dialogue | null>(null);
  const [message, setMessage] = React.useState<{ ok: boolean; texte: string } | null>(null);
  const [occupe, setOccupe] = React.useState(false);

  React.useEffect(() => {
    if (!message?.ok) return;
    const t = setTimeout(() => setMessage(null), 8000);
    return () => clearTimeout(t);
  }, [message]);

  const executer = React.useCallback(async (fn: () => Promise<ActionResult>, succes: string) => {
    setOccupe(true);
    setMessage(null);
    try {
      const r = await fn();
      if (r.ok) { setMessage({ ok: true, texte: r.message ?? succes }); rafraichir(); }
      else setMessage({ ok: false, texte: r.error ?? "L'action n'a pas abouti." });
    } catch {
      // Une action peut avoir ÉCRIT avant de lever : on ne dit jamais « recommencez » à l'aveugle.
      setMessage({ ok: false, texte: "L'action n'a pas abouti (connexion ou serveur). Rechargez la page avant de recommencer : elle a pu se faire malgré tout." });
    } finally {
      setOccupe(false);
    }
  }, [rafraichir]);

  const ctx: Ctx = { page, f, ouvrir: setDialogue, executer, annoncer: (texte) => setMessage({ ok: true, texte }), occupe };

  return (
    <div className="space-y-4">
      {visibles.length > 1 && (
        // Au téléphone, une rangée qui glisse : sept vues repliées sur trois lignes repousseraient le contenu.
        <div className="no-scrollbar flex gap-1 overflow-x-auto rounded-lg border border-border bg-card p-1 sm:flex-wrap sm:overflow-visible" role="tablist" aria-label="Vues du stock">
          {visibles.map((v) => {
            const compte = v === "moi" ? aConfirmer : v === "magasin" ? pourLeMagasin : v === "comptages" ? aCompter : v === "tableau" ? pourLeTableau : 0;
            return (
              <button
                key={v} type="button" role="tab" aria-selected={vue === v} onClick={() => choisir(v)}
                className={cn(
                  "inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm font-medium transition-colors sm:min-h-0",
                  vue === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                {LIBELLE_VUE[v]}
                {compte > 0 && <Badge tone={vue === v ? "neutral" : "info"}>{compte}</Badge>}
              </button>
            );
          })}
        </div>
      )}

      {message && (
        <div
          role={message.ok ? "status" : "alert"}
          className={cn(
            "flex items-start justify-between gap-3 rounded-lg px-3 py-2 text-sm",
            message.ok ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive",
          )}
        >
          <span className="flex min-w-0 items-start gap-2 [overflow-wrap:anywhere]">
            {message.ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />}
            {message.texte}
          </span>
          <button type="button" onClick={() => setMessage(null)} aria-label="Fermer le message" className="-my-1 -mr-1.5 shrink-0 rounded p-2 hover:bg-black/5 sm:my-0 sm:mr-0 sm:p-0.5">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {vue === "moi" && <VueMoi ctx={ctx} />}
      {vue === "equipe" && <VueEquipe ctx={ctx} />}
      {vue === "magasin" && <VueMagasin ctx={ctx} />}
      {vue === "general" && <VueGenerale ctx={ctx} />}
      {vue === "comptages" && <VueComptages ctx={ctx} />}
      {vue === "tableau" && <VueTableau ctx={ctx} />}
      {vue === "medecins" && <VueMedecins page={page} />}

      {dialogue && (
        <FormulaireStock
          dialogue={dialogue} page={page} f={f}
          onClose={() => setDialogue(null)}
          onSucces={(texte) => setMessage({ ok: true, texte })}
        />
      )}
    </div>
  );
}
