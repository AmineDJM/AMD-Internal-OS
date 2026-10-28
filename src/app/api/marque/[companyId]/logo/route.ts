import { NextRequest, NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/session";
import { getMyCompanies } from "@/lib/company";
import { logoOctets, marqueEtCharte } from "@/platform/in-process/brand";

/**
 * LE LOGO D'UNE SOCIÉTÉ, pour l'aperçu de l'écran Marque — sous le même droit que la lecture du
 * registre : voir la société. Les octets sortent déchiffrés du stockage du Drive, jamais mis en
 * cache partagé (`private`).
 */
export async function GET(_req: NextRequest, props: { params: Promise<{ companyId: string }> }) {
  const params = await props.params;
  const user = await getCurrentUser();
  if (!user) return new NextResponse(null, { status: 401 });
  const mienne = (await getMyCompanies(user.id)).find((c) => c.id === params.companyId);
  if (!mienne) return new NextResponse(null, { status: 403 });
  const { marque } = await marqueEtCharte(mienne.id);
  const logo = await logoOctets(marque);
  if (!logo) return new NextResponse(null, { status: 404 });
  return new NextResponse(new Uint8Array(logo.octets), {
    headers: {
      "Content-Type": logo.png ? "image/png" : "image/jpeg",
      "Content-Length": String(logo.octets.length),
      "Cache-Control": "private, max-age=60",
    },
  });
}
