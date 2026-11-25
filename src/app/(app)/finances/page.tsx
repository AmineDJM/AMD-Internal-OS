import { redirect } from "next/navigation";
import { requireUser, safeLanding } from "@/lib/session";
import { userCan, type Module } from "@/lib/rbac";

/**
 * LE TABLEAU DE BORD DES FINANCES N'EXISTE PLUS — le module a deux écrans, pas trois.
 *
 * ── CE QU'IL PORTAIT, ET OÙ C'EST PARTI ─────────────────────────────────────────────────────
 *
 * Il montrait la trésorerie, ce que le DAF doit arbitrer et deux courbes. Rien ne s'y écrivait :
 * on y passait pour regarder, puis on allait travailler ailleurs — un écran d'escale, entre le
 * menu et le vrai écran.
 *
 *   • le SOLDE DE TRÉSORERIE, le détail par compte et la demande d'actualisation sont allés dans
 *     « Banque & paiements » : on y regarde ce qu'il y a en banque au moment où l'on décide ce
 *     qu'on paie, et non deux écrans plus tôt ;
 *   • le COCKPIT DU DAF (dépenses hors ordres, masse salariale à provisionner, résultat mensuel)
 *     a rejoint la Comptabilité — c'est du travail de comptable, il est désormais là où on le
 *     fait ;
 *   • les DEUX COURBES et les compteurs du mois n'ont pas été relogés. Ils n'étaient l'entrée
 *     d'aucun geste ; les déplacer aurait rouvert un écran d'escale sous un autre nom.
 *
 * ── POURQUOI UNE REDIRECTION PLUTÔT QU'UNE SUPPRESSION ──────────────────────────────────────
 *
 * `/finances` est cité par des notifications déjà parties, des liens d'audit et les favoris de
 * ceux qui y passaient tous les matins. Une adresse qui meurt fait chercher un écran supprimé et
 * conclure que le module a disparu ; celle-ci conduit là où le travail se fait.
 */
export default async function FinancesPage() {
  // LE PREMIER ÉCRAN OUVERT (24/11/2026) : chacun des trois a sa clé — rediriger d'office vers la banque renverrait
  // à l'accueil, avec un refus, quiconque n'a que la Comptabilité ou les Impôts.
  const user = await requireUser();
  const ouvert = ECRANS.find((e) => userCan(user, e.module, "VIEW"));
  redirect(ouvert?.href ?? safeLanding(user));
}

const ECRANS: readonly { module: Module; href: string }[] = [
  { module: "FINANCES_BANQUE", href: "/finances/paiements-a-faire" },
  { module: "FINANCES_COMPTABILITE", href: "/finances/comptabilite" },
  { module: "FINANCES_IMPOTS", href: "/finances/impots-cotisations" },
];
