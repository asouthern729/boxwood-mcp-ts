#!/usr/bin/env python3
"""One-time fix for commercial-renewal-template.xlsx (client feedback, 2026-09-15: "stretching... on
the logo and company branding" after widening column B to 60 for the Coverage column). Root cause:
the logo's drawing anchor is a twoCellAnchor spanning col0 (A) through col2 (C) -- i.e. it includes
column B -- so its rendered width is computed from the CURRENT column widths every time the file is
opened, regardless of editAs="oneCell" (that flag only governs how Excel's own UI transforms the
anchor on an interactive resize; it does not freeze the size against a column width already baked
into the saved file). Widening column B from ~18.86 to 60 stretched the image to ~2.2x its original
width while its height (computed from unchanged row heights) stayed the same -- visible distortion,
not just a uniform scale-up.

Fix: replace the twoCellAnchor with a oneCellAnchor -- an explicit fixed-size (ext cx/cy) anchor at
the same top-left point, computed from the ORIGINAL (pre-widening) column/row dimensions so it
matches exactly what the logo looked like before, and is now completely decoupled from column B's
width going forward (or any other future column-width change).
"""
import zipfile
import shutil

TEMPLATE_PATH = "assets/templates/commercial-renewal-template.xlsx"

# Computed from the original (pre-widening) column A/B/C widths and row 1-4 heights, matching the
# original twoCellAnchor's rendered span exactly (verified against the embedded image's own native
# aspect ratio, 538x147px = 3.660 -- computed 2236610/609600 = 3.669, matching within rounding).
FIXED_WIDTH_EMU = 2236610
FIXED_HEIGHT_EMU = 609600

OLD_DRAWING_PREFIX = '<xdr:twoCellAnchor editAs="oneCell"><xdr:from><xdr:col>0</xdr:col><xdr:colOff>19051</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>200025</xdr:rowOff></xdr:from><xdr:to><xdr:col>2</xdr:col><xdr:colOff>798336</xdr:colOff><xdr:row>3</xdr:row><xdr:rowOff>171450</xdr:rowOff></xdr:to>'
NEW_DRAWING_PREFIX = f'<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>19051</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>200025</xdr:rowOff></xdr:from><xdr:ext cx="{FIXED_WIDTH_EMU}" cy="{FIXED_HEIGHT_EMU}"/>'
OLD_DRAWING_SUFFIX = "</xdr:twoCellAnchor>"
NEW_DRAWING_SUFFIX = "</xdr:oneCellAnchor>"


def main():
    with zipfile.ZipFile(TEMPLATE_PATH) as z:
        drawing_xml = z.read("xl/drawings/drawing1.xml").decode("utf-8")

    if OLD_DRAWING_PREFIX not in drawing_xml:
        raise SystemExit("Expected twoCellAnchor prefix not found -- template may have already been fixed, or changed shape. Aborting without modifying anything.")

    new_xml = drawing_xml.replace(OLD_DRAWING_PREFIX, NEW_DRAWING_PREFIX).replace(OLD_DRAWING_SUFFIX, NEW_DRAWING_SUFFIX)

    # Rewrite the zip in place, replacing only xl/drawings/drawing1.xml, copying every other entry
    # through unchanged (byte-for-byte) to avoid disturbing anything else in the file.
    tmp_path = TEMPLATE_PATH + ".tmp"
    with zipfile.ZipFile(TEMPLATE_PATH) as zin, zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "xl/drawings/drawing1.xml":
                data = new_xml.encode("utf-8")
            zout.writestr(item, data)

    shutil.move(tmp_path, TEMPLATE_PATH)
    print(f"Replaced twoCellAnchor with a fixed {FIXED_WIDTH_EMU}x{FIXED_HEIGHT_EMU} EMU oneCellAnchor in {TEMPLATE_PATH}")


if __name__ == "__main__":
    main()
