import { redirect } from "next/navigation";

/**
 * LE PREMIER « REGISTRE DES MOYENS GÉNÉRAUX » (lot T3) A ÉTÉ RETIRÉ — décision de la Direction du 02/11/2026 : chez
 * Adventum, les moyens généraux sont la caisse d'avance (`/moyens-generaux`). Les salles et leurs réservations, seule
 * partie conservée, vivent sur `/salles` ; l'ancienne adresse y mène.
 */
export default function RegistreRetire() {
  redirect("/salles");
}
