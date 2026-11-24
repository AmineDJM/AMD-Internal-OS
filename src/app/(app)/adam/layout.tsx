import { exigerBureauAdam, OngletsAdam } from "@/platform/in-process/visibilite-adam";
import "../../chief.css";

/**
 * LE BUREAU D'ADAM — ses onglets « Boîte de réception », « Réglages d'Adam », « Bureau d'Adam » (Direction, 02/11/2026).
 * Ce qui vivait sous `/chief-of-staff` vit ici, déplacé sans rien supprimer. La porte est au niveau du SEGMENT
 * (`exigerBureauAdam`) : la clé `CHIEF_OF_STAFF` de la console (Super Admin seul par défaut, 24/11/2026) ; un autre compte
 * reçoit la page d'une adresse inconnue.
 *
 * La hauteur : la coque prend toute la fenêtre utile (`app-viewport-flush`) et la barre d'onglets en prend le haut ; le
 * bureau, écrit pour occuper seul la fenêtre, est ramené à la place qui reste (`.adam-corps`, `chief.css`).
 */
export default async function EcranAdamLayout({ children }: { children: React.ReactNode }) {
  const { conversation } = await exigerBureauAdam();
  return (
    <div className="app-viewport-flush -mx-3 -mt-3 -mb-3 flex flex-col overflow-hidden sm:-mx-4 sm:-mt-6 sm:-mb-6 lg:-mx-8 lg:-mb-8">
      <OngletsAdam conversation={conversation} />
      <div className="adam-corps min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
