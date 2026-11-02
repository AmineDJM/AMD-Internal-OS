import { exigerAdamVisible, OngletsAdam } from "@/platform/in-process/visibilite-adam";
import "../../chief.css";

/**
 * L'ÉCRAN D'ADAM DU SUPER ADMIN — ses onglets « Boîte de réception », « Réglages d'Adam », « Bureau d'Adam »
 * (Direction, 02/11/2026). Ce qui vivait sous `/chief-of-staff` vit ici, déplacé sans rien supprimer ; la porte est la
 * même (`exigerAdamVisible`, au niveau du SEGMENT) : un autre compte reçoit la page d'une adresse inconnue.
 *
 * La hauteur : la coque prend toute la fenêtre utile (`app-viewport-flush`) et la barre d'onglets en prend le haut ; le
 * bureau, écrit pour occuper seul la fenêtre, est ramené à la place qui reste (`.adam-corps`, `chief.css`).
 */
export default async function EcranAdamLayout({ children }: { children: React.ReactNode }) {
  await exigerAdamVisible();
  return (
    <div className="app-viewport-flush -mx-3 -mt-3 -mb-3 flex flex-col overflow-hidden sm:-mx-4 sm:-mt-6 sm:-mb-6 lg:-mx-8 lg:-mb-8">
      <OngletsAdam />
      <div className="adam-corps min-h-0 flex-1 overflow-y-auto">{children}</div>
    </div>
  );
}
