import { redirect } from "next/navigation";

/**
 * LE PREMIER « REGISTRE DES MOYENS GÉNÉRAUX » (lot T3) A ÉTÉ RETIRÉ — décision de la Direction du 02/11/2026 : chez
 * Adventum, les moyens généraux sont la caisse d'avance (`/moyens-generaux`). L'ancienne adresse mène à la caisse
 * (la réservation de salles est mise de côté, Direction 03/11/2026).
 */
export default function RegistreRetire() {
  redirect("/moyens-generaux");
}
