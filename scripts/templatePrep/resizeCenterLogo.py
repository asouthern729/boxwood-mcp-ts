#!/usr/bin/env python3
"""Follow-up to fixLogoAnchor.py (client feedback, 2026-09-15: "can we make it bigger? and
centered?"). Enlarges the logo ~1.39x (preserving its native 538x147px aspect ratio) and
horizontally centers it within the report's main content width (columns A-H, matching the width
"RENEWAL PROGRAM SUMMARY" and the Coverage table below it both use) rather than its original
top-left position.

Sizing constraint: the logo must still fit above row 6 ("Insured Name:") without visually
overlapping it. Rows 1-5 (18+27+5.25+18+18pt) minus the anchor's own 200025 EMU offset into row 1
leaves 895350 EMU of headroom -- 850000 EMU (leaving a small ~45000 EMU/3.6pt margin) is the
largest height that comfortably clears it. Width follows from that height via the native aspect
ratio (538/147 = 3.6599), giving 3110884 EMU -- still comfortably narrower than the full A-H width
(12334875 EMU) so it isn't clipped after centering. All figures computed with the standard
Excel column-width-to-pixel formula (MDW=7 for Calibri 11) -- see fixLogoAnchor.py for that
derivation's precedent on this same file.

Horizontal centering: (total A-H width - logo width) / 2 = 4611995.5 EMU from the sheet's left
edge, which lands 411471 EMU into column C (the anchor's `from` col/colOff) -- computed by walking
column widths A, B, C... subtracting each from the target offset until it lands inside one.
"""
import zipfile
import shutil

TEMPLATE_PATH = "assets/templates/commercial-renewal-template.xlsx"

NEW_WIDTH_EMU = 3110884
NEW_HEIGHT_EMU = 850000
NEW_FROM_COL = 2       # column C (0-indexed)
NEW_FROM_COL_OFF = 411471
NEW_FROM_ROW = 0       # unchanged -- same vertical starting row as before
NEW_FROM_ROW_OFF = 200025  # unchanged -- same vertical offset as before

OLD_FROM = '<xdr:from><xdr:col>0</xdr:col><xdr:colOff>19051</xdr:colOff><xdr:row>0</xdr:row><xdr:rowOff>200025</xdr:rowOff></xdr:from><xdr:ext cx="2236610" cy="609600"/>'
NEW_FROM = f'<xdr:from><xdr:col>{ NEW_FROM_COL }</xdr:col><xdr:colOff>{ NEW_FROM_COL_OFF }</xdr:colOff><xdr:row>{ NEW_FROM_ROW }</xdr:row><xdr:rowOff>{ NEW_FROM_ROW_OFF }</xdr:rowOff></xdr:from><xdr:ext cx="{ NEW_WIDTH_EMU }" cy="{ NEW_HEIGHT_EMU }"/>'


def main():
    with zipfile.ZipFile(TEMPLATE_PATH) as z:
        drawing_xml = z.read("xl/drawings/drawing1.xml").decode("utf-8")

    if OLD_FROM not in drawing_xml:
        raise SystemExit("Expected prior fixLogoAnchor.py anchor not found -- template may already be resized, or changed shape. Aborting without modifying anything.")

    new_xml = drawing_xml.replace(OLD_FROM, NEW_FROM)

    tmp_path = TEMPLATE_PATH + ".tmp"
    with zipfile.ZipFile(TEMPLATE_PATH) as zin, zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
        for item in zin.infolist():
            data = zin.read(item.filename)
            if item.filename == "xl/drawings/drawing1.xml":
                data = new_xml.encode("utf-8")
            zout.writestr(item, data)

    shutil.move(tmp_path, TEMPLATE_PATH)
    print(f"Resized logo to {NEW_WIDTH_EMU}x{NEW_HEIGHT_EMU} EMU, centered at col {NEW_FROM_COL}+{NEW_FROM_COL_OFF} EMU, in {TEMPLATE_PATH}")


if __name__ == "__main__":
    main()
