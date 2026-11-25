import { redirect } from "next/navigation";
import { requireUser } from "@/lib/session";
import { sitsOnPaymentCentre, trierFile } from "@/modules/finances/partage";
import { CHEMIN_MES_DEMANDES_DE_PAIEMENT } from "@/lib/chemins/finances";
import { chargerCentre, historiqueDuCentre } from "@/modules/finances/api";
import { contexteDuCentre } from "@/lib/queries/centre-contexte";
import { CentreBoard } from "./centre-board";
import { BarreEntites } from "./centre-navigation";
import { MenuCentre } from "./menu-centre";

export const dynamic = "force-dynamic";
export const metadata = { title: "Centre de paiement — AMD Internal OS" };

/**
 * LE CENTRE DE PAIEMENT — la Direction générale seule, le Directeur Général et le Super Admin (24/11/2026) : le centre
 * AUTORISE ou REFUSE, la comptabilité exécute.
 *
 * AUCUN décaissement ne quitte les Finances sans passer par ici, quel que soit son montant (Direction, 09/2026) ; le
 * seuil de 50 000 DZD survit comme un MARQUEUR qui trie la file (`isHighValue`, `trierFile`), jamais comme un filtre.
 * Ce qui décaisse sans ordre de dépense ne passe pas par ici (registre des chemins de paiement, `horsCentre()`).
 *
 * LA DISPOSITION (maquette validée le 24/11/2026, `CentrePaiement.dc.html`) : le titre, les pastilles des sociétés et
 * le menu ⋯ (« Déjà décidés », « Exporter ») ; à gauche la file « À décider » — les SEULS ordres en attente, triés ;
 * à droite la fiche de l'ordre choisi, avec tout ce qu'il faut lire avant d'autoriser (`contexteDuCentre`). Plus de
 * compteurs répétés, plus de description d'en-tête, plus de deux liens vers la même page : la file est le compte, la
 * fiche est le dossier.
 *
 * QUI N'Y SIÈGE PAS N'Y ENTRE PAS (Super Admin, 25/11/2026 : « une personne qui n'a pas accès à un module ne peut pas
 * l'ouvrir »). L'écran restait ouvert au demandeur, qui y suivait ses paiements — et la fiche de décision lui montrait ce
 * qui n'est écrit que pour la Direction générale : l'historique du bénéficiaire sur toute la société, le budget avant →
 * après. Le choix le plus sûr : le demandeur est RENVOYÉ vers « Mes demandes de paiement », où chaque dossier dit l'état
 * de son autorisation, qui a tranché, quand et pourquoi (`validations/paiements/[id]`). Le chargeur refuse de son côté
 * (`chargerCentre`), l'export aussi (`exporterOrdresCentre`).
 */
export default async function CentreDePaiementPage(props: { searchParams?: Promise<{ entite?: string; ordre?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();
  if (!sitsOnPaymentCentre(user)) redirect(CHEMIN_MES_DEMANDES_DE_PAIEMENT);

  // Le chargeur décide de la portée (sociétés ouvertes) et VALIDE l'entité de l'adresse.
  const centre = await chargerCentre(user, { entite: searchParams?.entite ?? null });
  const { canDecide } = centre;

  // LA FICHE DE CHAQUE ORDRE EN ATTENTE, en lot ; puis l'ordre de la file (échéance fixe proche, montant élevé, ancienneté).
  const [fiches, historique] = await Promise.all([
    contexteDuCentre(centre.idsEnAttente, user, centre.entiteChoisie),
    historiqueDuCentre(centre.idsDecides),
  ]);
  const exportHref = `/api/finances/centre/export?entite=${encodeURIComponent(centre.entiteChoisie ?? "")}`;

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">Centre de paiement</h1>
        <div className="flex min-w-0 max-w-full items-center gap-2">
          <BarreEntites entites={centre.entites} choisie={centre.entiteChoisie} />
          <MenuCentre historique={historique} exportHref={exportHref} />
        </div>
      </header>

      <CentreBoard
        key={centre.entiteChoisie ?? "aucune"}
        file={trierFile(fiches)} canDecide={canDecide} initiale={searchParams?.ordre ?? null}
      />
    </div>
  );
}
