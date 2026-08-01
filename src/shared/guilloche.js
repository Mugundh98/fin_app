/* Guilloche engraving — the rosette pattern used on share certificates.
   Shared by every planner masthead. Pass the <svg> to draw into; a missing
   element is a no-op so pages can drop the masthead without breaking. */

const NS = "http://www.w3.org/2000/svg";

function gcd(a, b){ return b ? gcd(b, a % b) : a; }

export function drawGuilloche(svg){
  if(!svg) return;
  for(let c = 0; c < 7; c++){
    const cx = 60 + c * 185, cy = 100;
    for(let ring = 0; ring < 3; ring++){
      const R = 68 - ring * 15, r = 17 + ring * 4, d = 40 - ring * 7;
      let path = "";
      for(let t = 0; t <= Math.PI * 2 * r / gcd(R, r) * 1.02; t += 0.03){
        const x = cx + (R - r) * Math.cos(t) + d * Math.cos((R - r) / r * t);
        const y = cy + (R - r) * Math.sin(t) - d * Math.sin((R - r) / r * t);
        path += (path ? "L" : "M") + x.toFixed(1) + " " + y.toFixed(1);
      }
      const p = document.createElementNS(NS, "path");
      p.setAttribute("d", path);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", "#8FA6C4");
      p.setAttribute("stroke-width", "0.4");
      svg.appendChild(p);
    }
  }
}
