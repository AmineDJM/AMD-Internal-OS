import { hasRole, userCan, type SessionUser } from "@/lib/rbac";
import { sansBloquer } from "@/lib/journal";
import { lignesBcDePoste, lignesDevisPriseEnCharge, lignesFichesVoyage, lignesMaterielPromo } from "@/lib/queries/bureau-familles";
import { estOuverte, type LigneBureau } from "@/lib/secretariat/ligne-bureau";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « VOS AUTRES TÂCHES » — ce que l'assistante de direction fait ailleurs dans Ad & Pro, sur sa page « Prospection d'agences »
 * (Direction, 23/11/2026 : « tout ce qu'elle faisait dans Ad & Pro dans UNE page » ; rétabli par le Super Admin le 25/11/2026,
 * la page redevenant un module à part du bureau du secrétariat).
 *
 * Rien n'est recalculé : ce sont les familles qui nourrissent déjà le bureau (`bureau-familles.ts`) — les BC de poste (qui
 * ne vivent plus qu'ici), les devis des prises en charge, le matériel promotionnel, et le compte des fiches de voyage. Chaque
 * ligne mène à UNE page qu'elle ouvre, avec UN geste ; la plus ancienne d'abord.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

interface AutreTache {
  cle: string;
  titre: string;
  detail: string;
  /** Le geste, dit sur le lien (« Établir le BC », « Saisir les devis »…). */
  geste: string;
  href: string;
  /** ISO — depuis quand ; `null` quand rien ne le date. */
  depuis: string | null;
}

export interface GroupeAutresTaches {
  cle: "BC" | "DEVIS" | "PROMO" | "VOYAGES";
  titre: string;
  lignes: AutreTache[];
}

/** La plus ancienne d'abord ; ce que rien ne date garde son rang, après. */
const parAnciennete = (a: AutreTache, b: AutreTache) => (a.depuis ?? "￿").localeCompare(b.depuis ?? "￿");

/** Une ligne du bureau, dite comme une tâche : son objet, sa référence, ce qui reste (« 2 éléments à chiffrer »), son geste. */
const tache = (l: LigneBureau, geste: string): AutreTache => ({
  cle: l.cle, titre: l.objet, geste, href: l.href, depuis: l.depuis,
  // « Vous » ne dit rien sur sa propre page : seul ce qui suit compte.
  detail: [l.reference, l.chezQui?.replace(/^Vous(?: · )?/, "")].filter(Boolean).join(" · ") || l.type,
});

/**
 * LES AUTRES TÂCHES DE L'ASSISTANTE, par famille — `[]` pour toute autre personne (sa page à elle seule). Une source qui échoue
 * n'éteint pas les autres : la page dit ce qu'elle sait.
 */
export async function autresTachesAssistante(user: SessionUser): Promise<GroupeAutresTaches[]> {
  if (!hasRole(user, "DIRECTION_ASSISTANT")) return [];
  // Le bureau du secrétariat (`/demandes`) est SON module : sans lui, la ligne des fiches de voyage ne s'ouvrirait pas.
  const bureau = userCan(user, "ADMIN_REQUESTS", "VIEW");
  const [bc, devis, promo, fiches] = await Promise.all([
    lignesBcDePoste(user).catch(sansBloquer("autresTachesAssistante.lignesBcDePoste", [] as LigneBureau[])),
    lignesDevisPriseEnCharge(user).catch(sansBloquer("autresTachesAssistante.lignesDevisPriseEnCharge", [] as LigneBureau[])),
    lignesMaterielPromo(user).catch(sansBloquer("autresTachesAssistante.lignesMaterielPromo", [] as LigneBureau[])),
    bureau ? lignesFichesVoyage(user).catch(sansBloquer("autresTachesAssistante.lignesFichesVoyage", [] as LigneBureau[])) : Promise.resolve([]),
  ]);
  // Un BC de poste est à elle tant qu'elle doit le déposer (à établir) ou le redéposer (refusé) ; déposé, le demandeur le vérifie.
  const bcAFaire = bc.filter((l) => l.etat === "A_PRENDRE" || l.etat === "EN_COURS");
  // Les fiches de voyage se traitent au bureau, groupées : UNE ligne, qui y mène.
  const voyages = fiches.filter((l) => l.etat === "A_PRENDRE" || l.etat === "EN_COURS");
  const plusAncienne = voyages.map((l) => l.depuis).sort()[0] ?? null;
  const groupes: GroupeAutresTaches[] = [
    { cle: "BC", titre: "Bons de commande à établir", lignes: bcAFaire.map((l) => tache(l, l.etat === "EN_COURS" ? "Redéposer le BC" : "Établir le BC")).sort(parAnciennete) },
    { cle: "DEVIS", titre: "Devis à obtenir", lignes: devis.filter((l) => estOuverte(l.etat)).map((l) => tache(l, "Saisir les devis")).sort(parAnciennete) },
    { cle: "PROMO", titre: "Matériel promotionnel", lignes: promo.map((l) => tache(l, "Ouvrir le dossier")).sort(parAnciennete) },
    {
      cle: "VOYAGES", titre: "Billets et hôtels",
      lignes: voyages.length === 0 ? [] : [{
        cle: "fiches", titre: `${voyages.length} fiche${voyages.length > 1 ? "s" : ""} de voyage à traiter`,
        detail: "Billets et hôtels envoyés par les demandeurs", geste: "Ouvrir le bureau", href: "/demandes", depuis: plusAncienne,
      }],
    },
  ];
  return groupes.filter((g) => g.lignes.length > 0);
}
