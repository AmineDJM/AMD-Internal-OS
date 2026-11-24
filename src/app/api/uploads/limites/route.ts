import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getAppSettings } from "@/lib/settings";
import { objectStorageConfigured } from "@/lib/storage/object-storage";
import { SEUIL_DIRECT_OCTETS } from "@/lib/storage/televersement-direct";
import { MAX_SANS_STOCKAGE_OBJET_MO } from "@/lib/storage/phrases-stockage";

export const dynamic = "force-dynamic";

/**
 * LES LIMITES D'ENVOI, lues par le navigateur AVANT d'envoyer (audit du 04/10, constat 11).
 *
 * Sans elles, un fichier trop lourd partait en entier, puis revenait sur « Body exceeded » ou une
 * erreur générique — après de longues minutes d'attente. Le navigateur refuse désormais tout de
 * suite, avec la taille du fichier et la limite. Aucune donnée sensible : des nombres et un
 * booléen (« le stockage objet est-il branché ? »), jamais un nom de bucket ni une clé.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Non authentifié." }, { status: 401 });
  const s = await getAppSettings();
  return NextResponse.json({
    maxUploadMb: s.maxUploadMb,
    maxDriveUploadMb: s.maxDriveUploadMb,
    stockageObjet: objectStorageConfigured(),
    seuilDirectOctets: SEUIL_DIRECT_OCTETS,
    maxSansStockageObjetMo: MAX_SANS_STOCKAGE_OBJET_MO,
    // La marche à suivre technique d'un refus (variables du stockage objet) ne s'adresse qu'au Super Admin.
    technique: user.role === "SUPER_ADMIN",
  }, { headers: { "Cache-Control": "private, max-age=60" } });
}
