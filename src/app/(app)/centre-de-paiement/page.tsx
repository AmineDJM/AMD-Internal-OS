import { requireUser } from "@/lib/session";
import { EmptyState } from "@/components/shared/empty-state";
import { PAYMENT_CENTRE_REFUSAL, trierFile } from "@/modules/finances/partage";
import { chargerCentre, historiqueDuCentre } from "@/modules/finances/api";
import { contexteDuCentre } from "@/lib/queries/centre-contexte";
import { CentreBoard } from "./centre-board";
import { BarreEntites } from "./centre-navigation";
import { MenuCentre } from "./menu-centre";

export const dynamic = "force-dynamic";
export const metadata = { title: "Centre de paiement — AMD Internal OS" };

/**
 * LE CENTRE DE PAIEMENT — le PDG, le Directeur Général, le Super Admin et les sièges nommés : le centre AUTORISE ou
 * REFUSE, la comptabilité exécute.
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
 * L'écran reste ouvert au DEMANDEUR qui ne siège pas : il y suit ses propres paiements, sans gestes de décision.
 * Qui n'y siège pas et n'a rien demandé lit la règle et le geste qui l'y fait entrer.
 */
export default async function CentreDePaiementPage(props: { searchParams?: Promise<{ entite?: string; ordre?: string }> }) {
  const searchParams = await props.searchParams;
  const user = await requireUser();

  // Le chargeur décide de la portée (sociétés ouvertes, siège ou demandeur) et VALIDE l'entité de l'adresse.
  const centre = await chargerCentre(user, { entite: searchParams?.entite ?? null });
  const { canDecide } = centre;

  if (!canDecide && centre.aucunOrdre) {
    return (
      <div className="space-y-5">
        <h1 className="text-2xl font-bold">Centre de paiement</h1>
        <EmptyState icon="ShieldAlert" title="Vous ne siégez pas au centre de paiement" description={PAYMENT_CENTRE_REFUSAL} />
        <p className="text-center text-xs text-muted-foreground">
          Cocher le module « Centre de paiement » dans la grille des accès ne suffit pas, et poser un « autre rôle »
          non plus : le siège se donne <strong>par votre nom</strong>, depuis Administration → Accès → « Qui siège au
          centre de paiement ».
        </p>
      </div>
    );
  }

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
