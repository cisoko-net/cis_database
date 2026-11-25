'use strict';

// Sort keys for MariaDB's _ci text collations. SQLite compares a function's
// text result byte for byte, so ORDER BY key(col) and key(col) < key(?)
// order and compare as MariaDB does. dialect.js registers them as cis_ci
// (general_ci) and cis_uci (unicode_ci) and decides where they apply.
//
// The file is two compressed weight tables (the *_RUNS strings) followed by
// the function that expands each table once, on first use, into a typed array
// and the key function that reads it (generalCiKey skips the table for plain
// ASCII text). Regenerate a table from MariaDB with
// WEIGHT_STRING() rather than editing it by hand.

// utf8mb4_general_ci, utf8mb4's default collation in MariaDB 10.x, compares
// text by a 16-bit weight per character: letters fold to upper case, most
// accented letters fold to their base letter, and every character outside
// the BMP weighs FFFD. Trailing spaces do not count (PAD SPACE). SQLite's
// NOCASE folds A-Z to lower case instead, so it sorts [ \ ] ^ _ ` before the
// letters where MariaDB sorts them after, and it never folds accents.
// generalCiKey turns a string into its weights as a string, whose binary
// order is MariaDB's order; ORDER BY and range comparisons on such columns
// go through it (dialect.js, collateText). Equality stays on NOCASE, which an
// index can serve.
//
// The weights were read from MariaDB 10.11 with WEIGHT_STRING(... COLLATE
// utf8mb4_general_ci) for every BMP code point. Code points not listed weigh
// themselves. Each entry is start,count,value (start,count/value steps by 2)
// in base 36; the value is a delta from the code point, or =w, a weight.
// utf8mb3_general_ci has the same table.
const GENERAL_CI_RUNS = [
    '2p,q,-w 51,1,kn 5c,6,=1t 5j,2/-3o 5k,2/=1x 5n,1,-3q 5o,4,=21 5t,2,-3n 5v,4,=27 61,4,=2d 65,1,-3o',
    '67,1,-3w 68,6,=1t 6e,1,-w 6f,2/-4k 6g,2/=1x 6j,1,-4m 6k,4,=21 6o,1,-w 6p,2,-4j 6r,4,=27 6w,1,-w',
    '6x,4,=2d 71,2/=2h 72,1,-w 74,6,=1t 7a,8,=1v 7i,2,=1w 7l,1,-1 7m,a,=1x 7w,8,=1z 84,2,=20 87,1,-1',
    '88,a,=21 8j,1,-1 8k,2,=22 8m,2,=23 8p,6,=24 8w,2/-1 8z,6,=26 97,1,-1 98,6,=27 9f,1,-1 9g,6,=2a',
    '9m,8,=2b 9u,4,=2c 9z,1,-1 a0,c,=2d ac,2,=2f ae,3,=2h ah,6,=2i an,1,-8c ar,2/-1 aw,1,-1 b0,1,-1',
    'b6,1,-1 b9,1,2p bd,1,-1 bk,2,=27 bn,2/-1 bs,1,-1 bx,1,-1 bz,2,=2d c4,2/-1 c9,1,-1 cd,1,-1',
    'cf,1,1k cl,2,=ck co,2,=cn cr,2,=cq ct,2,=1t cv,2,=21 cx,2,=27 cz,a,=2d d9,1,-27 da,4,=1t',
    'de,2,=5i dh,1,-1 di,2,=1z dk,2,=23 dm,4,=27 dq,2,=c7 ds,1,-bq du,2,=dt dw,2,=1z e0,2,=26',
    'e2,2,=1t e4,2,=5i e6,2,=60 e8,4,=1t ec,4,=1x eg,4,=21 ek,4,=27 eo,4,=2a es,4,=2d ew,2,=2b',
    'ey,2,=2c f1,1,-1 f2,2,=20 f7,2/-1 fa,2,=1t fc,2,=1x fe,8,=27 fm,2,=2h gj,1,-5u gk,1,-5q gm,2,-5p',
    'gp,1,-5m gr,1,-5n gw,1,-5p gz,1,-5r h4,1,-5t h5,1,-5v hb,1,-5v he,1,-5x hh,1,-5y hs,1,-62',
    'hv,1,-62 i0,1,-62 i2,2,-61 ia,1,-63 n9,1,2c p2,1,b p4,1,d p5,1,e p6,1,f p8,1,j pa,1,n pb,1,q',
    'pc,1,9 q2,1,-h q3,1,-6 q4,1,-r q5,1,-o q6,1,-n q7,1,-m q8,1,-b q9,h,-w qq,2,=pv qs,6,-w qy,1,-1d',
    'qz,2/=px r0,1,-19 r2,1,-11 r4,1,-1q r5,1,-1l r7,2,=r6 r9,1,-1b ra,1,-1i rf,b/-1 s0,1,-2e',
    's1,1,-28 s2,1,-27 sg,2,=t1 sj,1,g sn,1,-1 ss,1,e st,1,b su,1,l ts,w,-w uo,2,=t1 uq,5/-28',
    'ur,1,-1s ut,1,-28 uv,1,-29 ux,2/-28 v0,1,-1u v1,1,-1x v2,1,-1n v3,1,-28 v5,b/-1 vq,2,=vo vt,5/-1',
    'wd,q/-1 xt,2,=t2 xw,1,-1 y0,1,-1 y4,1,-1 y8,4,=sw yd,1,-1 ye,2,=t1 yh,3,=yg yk,2,=t2 ym,2,=t3',
    'yp,1,-1 yq,4,=t4 yu,2,=ta yx,3,=yw z0,2,=tp z2,6,=tf z8,2,=tj zc,2,=tn 129,12,-1c 5xc,2,=1t',
    '5xe,6,=1u 5xk,2,=1v 5xm,a,=1w 5xw,a,=1x 5y6,2,=1y 5y8,2,=1z 5ya,a,=20 5yk,4,=21 5yo,6,=23',
    '5yu,8,=24 5z2,6,=25 5z8,8,=26 5zg,8,=27 5zo,4,=28 5zs,8,=2a 600,a,=2b 60a,8,=2c 60i,a,=2d',
    '60s,4,=2e 60w,a,=2f 616,4,=2g 61a,2,=2h 61c,6,=2i 61i,1,-5zi 61j,1,-5z7 61k,1,-5z5 61l,1,-5z4',
    '61n,1,-5zc 61s,o,=1t 62g,g,=1x 62w,4,=21 630,o,=27 63o,e,=2d 642,8,=2h 64g,g,=pd 64w,6,=ph',
    '654,6,=ph 65c,g,=pj 65s,g,=pl 668,6,=pr 66g,6,=pr 66o,8,=px 66x,4/=px 674,g,=q1 67k,1,-5i7',
    '67l,1,22 67m,3/-5i5 67n,2/2e 67r,1,2s 67s,1,-5i1 67t,1,3k 67u,1,-5hx 67v,1,34 67w,1,-5hv',
    '67x,1,3i 680,g,=pd 68g,g,=pj 68w,g,=q1 69c,7/=pd 69d,2/=pd 69j,2/=pd 69q,1,-5k5 69u,3,=pj',
    '69y,2,=pj 6a0,2/-5kj 6a4,1,-5kl 6a8,3,=pl 6ae,5,=pl 6ao,3,=px 6as,2,=pt 6au,5,=px 6b0,1,-5l7',
    '6b6,3,=q1 6ba,2,=q1 6bc,1,-5ll 6be,2/=q1 6ls,g,-g 79s,q,-q 1ef5,q,-w',
].join(' ');

let generalCiTable = null;

function generalCiWeights() {
    if (generalCiTable) return generalCiTable;
    const w = new Uint16Array(65536);
    for (let i = 0; i < 65536; i++) w[i] = i;
    for (const e of GENERAL_CI_RUNS.split(' ')) {
        const m = /^([0-9a-z]+),([0-9a-z]+)([,/])(=?)(-?[0-9a-z]+)$/.exec(e);
        const start = parseInt(m[1], 36);
        const step = m[3] === '/' ? 2 : 1;
        const v = parseInt(m[5], 36);
        for (let k = 0, n = parseInt(m[2], 36); k < n; k++) {
            const cp = start + k * step;
            w[cp] = m[4] ? v : cp + v;
        }
    }
    // A lone surrogate is not text MariaDB can hold; it weighs as a
    // character outside the BMP does.
    for (let i = 0xd800; i <= 0xdfff; i++) w[i] = 0xfffd;
    generalCiTable = w;
    return w;
}

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/**
 * The utf8mb4_general_ci sort key of v: one character per weight, so two
 * keys compare (byte for byte, as SQLite compares the function's result)
 * the way MariaDB compares the strings. Every weight is a BMP character
 * outside the surrogates, whose UTF-8 order is its code point order. Only
 * trailing spaces are dropped; a string that differs from another by a
 * control character after its last letter ('a\t' against 'a') sorts after
 * it here and before it in MariaDB. Anything but a string is returned as it
 * is.
 * @param {*} v
 * @returns {*}
 */
function generalCiKey(v) {
    if (typeof v !== 'string') return v;
    let end = v.length;
    while (end > 0 && v.charCodeAt(end - 1) === 32) end--;
    const s = end === v.length ? v : v.slice(0, end);
    // ASCII text only folds a-z.
    if (ASCII_ONLY.test(s)) return s.toUpperCase();
    const w = generalCiWeights();
    const out = [];
    let key = '';
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const d = s.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) i++;
        }
        out.push(w[c]);
        if (out.length === 4096) {
            key += String.fromCharCode.apply(null, out);
            out.length = 0;
        }
    }
    return key + String.fromCharCode.apply(null, out);
}


// utf8mb4_unicode_ci (and utf8mb3_unicode_ci) is UCA 4.0.0 at its first
// level: a character weighs zero or more 16-bit weights (controls weigh
// nothing, ß weighs as ss, a CJK ideograph two), case and accents fold, and
// punctuation sorts before digits and digits before letters. Every
// character outside the BMP weighs FFFD. Trailing spaces do not count.
//
// The weights were read from MariaDB 10.11 with WEIGHT_STRING(... COLLATE
// utf8mb4_unicode_ci) for every BMP code point. 4,000 random strings of
// Latin, Greek, Cyrillic, Hebrew, Arabic, Thai, Lao, Hangul, kana, CJK and
// combining marks each weighed what their characters weigh one by one, so
// the collation has no contractions to model. Each run is gap[*n]:w1.w2[/d1.d2]
// in base 36: it starts gap code points after the previous run ends, covers
// n code points (1 when left out), the first weighs w1 w2 ..., and each next
// one adds d1 d2 ... (0 when left out).
const UNICODE_CI_RUNS = [
    '0*9: 0*5:e9/1 0*i: 0*2:eh/20 0*2:hq/2c 0*2:2rz/-27w 0*2:jz/-2g 0*2:i0/1 0*2:js/9s 0*2:fj/-e',
    '0*2:gt/33 0*a:2sp/1 0*2:fx/-3 0*3:to/1 0*2:gl/36 0*2:2sz/n 0*2:2u8/d 0*2:2vf/1a 0*2:2wx/w',
    '0*2:2yj/l 0*2:2zl/d 0*2:317/9 0*2:32a/11 0*2:33o/c 0*2:356/o 0*2:36n/11 0*2:381/9 0*2:38e/c',
    '0*2:i2/1w 0*2:i3/-3g 0*2:ez/-f 0*2:2sz/n 0*2:2u8/d 0*2:2vf/1a 0*2:2wx/w 0*2:2yj/l 0*2:2zl/d',
    '0*2:317/9 0*2:32a/11 0*2:33o/c 0*2:356/o 0*2:36n/11 0*2:381/9 0*2:38e/c 0*2:i4/bo 0*2:i5/bq 0*6:',
    '0:ee 0*q: 0*2:eh/21 0*2:2ry/2 0*2:2rx/4 0*2:tt/-a7 0*2:es/4x 0*2:2sz/-2b1 0*2:tr/-en 0*2:jq/-52',
    '0*2:ne/67 0*2:2sr/1 0*2:el/2y3 0*2:jn/-2k 0*2:ex/2dt 0*2:32a/-2kb 0*2:2sq.jx.2st/0.0.-2',
    '0:2ss.jx.2st 0*2:gm/2cd 0*5:2sz 0*2:2t4/14 0*4:2vf 0*4:2yj 0*2:2va/66 0*5:32a 0*2:tn/28y 0*4:36n',
    '0*2:38e/1i 0:356.356 0*6:2sz 0*2:2t4/14 0*4:2vf 0*4:2yj 0*2:2va/66 0*5:32a 0*2:tm/28z 0*4:36n',
    '0*2:38e/1i 0*2:38e/-ff 0*5:2sz 0*8:2u8 0*2:2ul 0*2:2uq 0*a:2vf 0*8:2wx 0*2:2xt 0*2:2y5 0*9:2yj',
    '0:2yn 0*2:2yj.2z4 0*2:2z4 0*2:2zl 0*2:33w/-3y 0*5:2zy 0*2:2zy.h3 0*2:306 0*6:31g 0:3ap.31g',
    '0*2:326 0*6:32a 0*2:32a.2vf 0*6:340 0*8:356 0*4:35u 0*2:35z 0*c:36n 0*2:381 0*3:38e 0*6:38q',
    '0*2:356/-bc 0*2:2u0/4 0*2:2u4/gc 0*2:3ag/-7q 0*2:2ud 0*3:2uu/4 0:2v2 0:38q.381 0*3:2vk/4 0*2:2wt',
    '0*2:2xd/8 0*2:2y1/z 0*2:2yw/u 0*2:2zq/l 0*2:30z/6c 0*2:31q/4 0*2:32y/-o 0*2:32a/-4l 0*2:2xp/5r',
    '0*2:33g/o 0*2:3a8 0*2:35e/4 0*2:363/4 0*2:367/4 0*2:36n 0*2:37k/9 0*2:38m 0*2:38v 0*2:39b/5',
    '0*2:39g/4 0*2:3a4/8 0:3ac 0:35u.356 0*2:3a0/1c 0*3:3bg/4 0*3:2ul.38q 0*3:2zy.2z4 0*3:31g.2z4',
    '0*2:2sz 0*2:2yj 0*2:32a 0*a:36n 0*2:2vk/-2l 0*3:2sz 0*2:2t4 0*2:2x9 0*2:2wx 0*2:2zl 0*4:32a',
    '0*2:39b 0:2z4 0*3:2ul.38q 0*2:2wx 0*2:2y1/bz 0*2:31g 0*2:2sz 0*2:2t4 0*2:32l 0*4:2sz 0*4:2vf',
    '0*4:2yj 0*4:32a 0*4:340 0*4:36n 0*2:356 0*2:35u 0*2:39s 0*2:2xt 0*2:31u/-6o 0*2:336 0*2:38z',
    '0*2:2sz 0*2:2vf 0*8:32a 0*2:38e 0*2:30r/1b 0:36f 0*p:1dq8.ppz/0.1 0*3:2ta/4 0*2:2u0/8q 0*2:2uh/d',
    '0*2:2uy/y 0*2:2vo/c 0*2:2vs/c 0*2:2w9/4 0*2:2zd/-20 0*2:2x1/4 0*2:2xl/-10 0*2:36z/-8q 0*2:2yd/j',
    '0*2:2z0/-9 0*3:30f/4 0*2:30v/6g 0*2:37g/-64 0*2:31q/8 0*2:31k/1e 0*2:32g/m 0*2:33k/p 0*6:34e/4',
    '0*2:344/y 0*2:35a/4 0*2:2zh/65 0*2:35q/t 0*2:36b/k 0*2:37k/9 0*2:37x/9 0*2:313/7f 0*3:393/4',
    '0*2:39o/w 0*2:3as/g 0*2:3bs/4 0*2:2tq/2r 0*2:2xh/g 0*2:2z9/l 0*2:302/3q 0*2:3b0/4',
    '0*2:2ul.38q/0.l 0*2:2ul.397/b9.-41 0*2:35u.35e/0.-ax 0*2:2wp.326/39.30 0:2zy.38q 0*2:3c0/4',
    '0*2:373/4 0*2:2xt/g 0*2:2z4/4w 0*2:349/9 0*2:352/2z 0*2:38e/-2mf 0*2:m1/2cg 0*2:3ap/-c7',
    '0*2:3ar/5 0*2:3ao/9 0*e:m2/1 0*2:2rl/1 0*6:mg/1 0*2:eq/1 0*2:et/5 0*2:em/8 0*2:mm/1 0*2:2xl/2d',
    '0*2:356/34 0*2:3as/-2o4 0*8:mp/1 0*2:3aq/-2nt 0*g:my/1 0*2g: 0*5:1dq8.py0/0.1 0*6: 0*2:2sz/2g',
    '0*2:2yj/3r 0*2:36n/-cf 0*2:2ul/38 0*2:317/2t 0*2:35u/1u 0:38a 0*4:1dq8.pyo/0.1 0*2:lz/1',
    '0*4:1dq8.pyu/0.1 0:3cj 0*3:1dq8.pyz/0.1 0:fu 0*5:1dq8.pz3/0.1 0*2:el/7 0*2:3c8/-2v5 0*2:3cd/4',
    '0:3cj 0:1dq8.pzf 0:3cr 0:1dq8.pzh 0*2:3d0/5 0*2:3cj/-b 0*2:3c9/1 0*2:3cc/1 0*4:3cg/1 0*2:3cl/1',
    '0*5:3co/1 0:3cw 0:1dq8.q02 0*6:3cy/1 0*2:3d5/-m 0*2:3d0/-s 0*2:3cd/4 0*2:3cj/h 0*3:3c8/1',
    '0*2:3cc/1 0*4:3cg/1 0*2:3cl/1 0*5:3co/1 0*2:3cw/2 0*6:3cy/1 0*2:3d5/-m 0*2:3d0/-9 0*2:3d0/5',
    '0:1dq8.q1b 0*2:3c9/9 0*3:3d0 0*2:3d1/-9 0:3cl.3c8.3cj 0*2:3cv 0*2:3cf 0*2:3ce 0*2:3cu 0*2:3d6',
    '0*2:3d9 0*2:3da 0*2:3db 0*2:3dc 0*2:3dd 0*2:3de 0*2:3df 0*2:3cl/b 0*2:3cy/-e 0*2:3ci/-5',
    '0*2:tf/2js 0*2:3d7/-9 0*2:3d8 0*4:1dq8.q2k/0.1 0*2:3f6 0*2:3et/5 0*2:3fe/p 0*2:3go/4 0*2:3h0/11',
    '0*2:3iy/1n 0*2:3kp/-4d 0*2:3kx/2k 0*2:3dg/o 0*2:3e8/4 0*2:3eo/i 0*2:3fi/c 0*2:3gc/k 0*2:3h4/o',
    '0*2:3i6/8 0*2:3j3/g 0*2:3jv/8 0*2:3kc/h 0*2:3ll/4 0*2:3mh/8 0*4:3nl/4 0*2:3o5/c 0*2:3op/4',
    '0*2:3dg/o 0*2:3e8/4 0*2:3eo/i 0*2:3fi/c 0*2:3gc/k 0*2:3h4/o 0*2:3i6/8 0*2:3j3/g 0*2:3jv/8',
    '0*2:3kc/h 0*2:3ll/4 0*2:3mh/8 0*4:3nl/4 0*2:3o5/c 0*2:3op/4 0*2:3f6 0*2:3et/5 0*2:3fe/p',
    '0*2:3go/4 0*2:3h0/11 0*2:3iy/1n 0*2:3kp/-4d 0*2:3kx/2k 0*2:3m1 0*2:3od 0*2:3ox 0*2:3p1 0*2:3p9',
    '0*2:3p5 0*2:3pd 0*2:3ph 0*2:3pl 0*2:3pp 0*2:3pt 0*2:3px 0*2:3lh 0*2:3md 0*2:3m9 0*2:3m5 0*2:3jr',
    '0:nf 0*4: 0:1dq8.q6f 0*2: 0*2:3gg 0*2:3o9 0*2:3jz 0*2:3ec 0*2:3eg 0*2:3ek 0*2:3fq 0*2:3f2',
    '0*2:3h8 0*2:3ho 0*2:3hk 0*2:3hg 0*2:3im 0*2:3iu 0*2:3jn 0*2:3q1 0*2:3k8 0*2:3kh 0*2:3l9 0*2:3ld',
    '0*2:3lt 0*2:3ml 0*2:3mx 0*2:3n5 0*2:3lx 0*2:3n9 0*2:3nd 0*2:3q5/-an 0*2:3fi/1u 0*2:3hc/l',
    '0*2:3hx/t 0*2:3iq/-8 0*2:3ii/4j 0*2:3n1/-4r 0:3ia 0:1dq8.q8f 0*2:3dk 0*2:3do 0*2:3e0 0*2:3fa',
    '0*2:3ds 0*2:3dw 0*2:3fm 0*2:3fz 0*2:3g7 0*2:3gc 0*2:3gk 0*2:3j7 0*2:3jb 0*2:3jf 0*2:3ol 0*2:3kt',
    '0*2:3l1 0*2:3l5 0*2:3mt 0*2:1dq8.q9i/0.1 0*2:3o1 0*6:1dq8.q9m/0.1 0*2:3es 0*2:3ex 0*2:3fy',
    '0*2:3gb 0*2:3i5 0*2:3j2 0*2:3k7 0*2:3kg 0*x:1dq8.qa8/0.1 0*12:3re/1 0*2:1dq8.qc7/0.1',
    '0*2:3sg/-37o 0*2:kt/-4a 0*2:fk/13 0:ku 0:1dq8.qcg 0*12:3re/1 0*2:3ri.3sb/19yq.ml9 0*2:fy/-s',
    '0*6:1dq8.qdn/0.1 0*h: 0:1dq8.qea 0*n: 0:1dq8.qey 0*3: 0:kv 0: 0:kw 0*2: 0:kx 0: 0*b:1dq8.qf9/0.1',
    '0*b:3sh/1 0*3:3sr/1 0*2:3st/1 0*4:3su/1 0*2:3sx/1 0*5:3sy/1 0*5:1dq8.qgb/0.1 0*2:3sm.3sm/0.4',
    '0:3sq.3sq 0*2:ky/1 0*b:1dq8.qgl/0.1 0*4: 0*8:1dq8.qh0/0.1 0*2:fl/1 0*2:ng/1 0*6:',
    '0*5:1dq8.qhi/0.1 0:fv 0*3:1dq8.qho/0.1 0:go 0:1dq8.qhs 0*3:3t3/1 0*2:3t8/1 0*2:3tb/1 0*2:3te/4',
    '0*2:3tj/1 0*2:3tq/6 0*2:3tx/4 0*2:3u2/b 0*2:3ue/b 0*2:3uq/5 0*2:3uw/4 0*2:3v1/2 0:3v4',
    '0*5:1dq8.qij/0.1 0*2:ej/3go 0*2:3vf/3 0*2:3vv/5 0*3:3w1/6 0*2:3wn/1 0*e: 0*7:1dq8.qjd/0.1',
    '0*a:2sp/1 0*2:k4/-4h 0*2:fo/47 0*2:3td/21 0: 0*2:3t7/-1 0*2:3ta/-7 0*2:3tc.3t3/31.0',
    '0*2:3wh.3t3/7.0 0*2:3tl/1 0*2:3tf/8 0*2:3to/-8 0*2:3tp/-8 0*2:3ty/1 0*2:3tr/1 0*2:3u0/-7',
    '0*2:3tv/8 0*8:3u4/1 0*9:3uf/1 0*3:3ur/1 0*2:3ux/1 0*3:3v2/3 0*5:3v9/1 0*2:3vg/1 0*c:3vj/1',
    '0*4:3vw/1 0*2:3w6/-4 0*3:3w3/1 0*2:3w8/-2e 0*2:3wc/-3 0*2:3w9/1 0*8:3we/1 0*3:3wp/1 0*2:3wm/6',
    '0*2:3wt/1 0*2:3wu/-3fz 0:3wc 0*f: 0*2:3wd/b 0*2: 0:ni 0*4: 0*2:3uc/c 0*a:2sp/1 0*2:3uu/5',
    '0*2:3v6/-23 0*2:3w0/b 0*2:hc/-g 0*2:gx/-y 0*5:g0/1 0*2:gp/4b 0*3:l1/1 0:1dq8.qoe 0: 0:3wv 0:',
    '0*2:3ww/1 0*2:3wx/2 0*2:3wy/2 0*2:3x1/1 0*2:3x4/1 0*4:3x5/1 0*4:3xa/1 0*3:3xd/1 0*2:3xf/2',
    '0*4:3xi/1 0*2:3ww/1 0:3wz 0*r: 0*2:1dq8.qq3/0.1 0*2:3x3/6 0:3xg 0*1c:1dq8.qq8/0.1 0*2:3xm/3',
    '0*2:3xq/1 0*4:3xt/1 0*2:3xz/2 0*2:3y2/1 0*2:3y5/4 0*2:3ya/2 0*2:3yd/4 0*6:3yi/1 0*2:3y6/-j',
    '0*2:3xo/g 0*2:3xs/m 0*2:3yf/1 0*2:3y7/1 0*2:3xx/1 0*2:3yb/-b 0*b:3yp/1 0:3yo 0*9b:1dq8.qsy/0.1',
    '0*3: 0*8:47u/1 0*2:483/2 0*r:486/1 0*8:48w/1 0*3:493/1 0*6:495/1 0*2:1dq8.r3u/0.1 0: 0*8:49b/1',
    '0*9:49l/1 0*2:1dq8.r4e/0.1 0:47t 0*4: 0*3:1dq8.r4l/0.1 0*3:48d/1 0*2:48k/5 0*2:48q/8 0*2:492/-10',
    '0*2:484/1f 0*2:49k/-3sg 0*2:h5/2bk 0*9:2sq/1 0:l6 0*g:1dq8.r5d/0.1 0*3: 0:1dq8.r5w 0*7:49u/1',
    '0:4a2 0*2:1dq8.r65/0.1 0*2:4a4/1 0*2:1dq8.r69/0.1 0*m:4a6/1 0:1dq8.r6x 0*7:4as/1 0:1dq8.r75',
    '0:4b0 0*3:1dq8.r77/0.1 0*4:4b2/1 0*2:1dq8.r7e/0.1 0: 0*8:4b6/1 0*2:1dq8.r7p/0.1 0*2:4bg/1',
    '0*2:1dq8.r7t/0.1 0*3:4bi/1 0*9:1dq8.r7y/0.1 0:4bl 0*4:1dq8.r88/0.1 0*2:4ak/1 0:1dq8.r8e',
    '0*2:4ax/-w 0*2:4a3/1b 0:4bf 0*2:1dq8.r8k/0.1 0*a:2sp/1 0*2:4az/2 0*2:2s2/1 0*4:2sq/1 0*2:2pz/1',
    '0:nk 0*6:1dq8.r97/0.1 0*3: 0:1dq8.r9g 0*2:4br/1 0*2:4bw/1 0*2:4bo/1 0*4:1dq8.r9n/0.1 0*2:4by/-5',
    '0*2:1dq8.r9t/0.1 0*2:4bq/4 0*k:4c1/1 0:1dq8.rah 0*7:4cl/1 0:1dq8.rap 0*2:4cs 0:1dq8.ras',
    '0*2:4ct/-u 0:1dq8.rav 0*2:4bz/1 0*2:1dq8.ray/0.1 0: 0:1dq8.rb1 0*5:4cv/1 0*4:1dq8.rb7/0.1',
    '0*2:4d0/1 0*2:1dq8.rbd/0.1 0*3:4d2/1 0*b:1dq8.rbi/0.1 0*2:4c2/1 0*2:4c8/m 0:1dq8.rbx 0:4cm',
    '0*7:1dq8.rbz/0.1 0*a:2sp/1 0*2: 0*2:4bv/-8 0:4bm 0*c:1dq8.rcl/0.1 0*3: 0:1dq8.rd0 0*7:4d6/1',
    '0*2:4de/2 0:1dq8.rda 0*3:4dh/1 0:1dq8.rde 0*m:4dk/1 0:1dq8.re1 0*7:4e6/1 0:1dq8.re9 0*2:4ed/1',
    '0:1dq8.rec 0*5:4ef/1 0*2:1dq8.rei/0.1 0: 0*8:4ek/1 0:4eu 0:1dq8.reu 0*3:4ev/1 0:1dq8.rey',
    '0*3:4ey/1 0*2:1dq8.rf2/0.1 0:4d5 0*f:1dq8.rf5/0.1 0*2:4dd/2 0*2:4es/1 0*2:1dq8.rfo/0.1 0*a:2sp/1',
    '0:1dq8.rg0 0:2s4 0*f:1dq8.rg2/0.1 0*3: 0:1dq8.rgk 0*7:4f1/1 0:4f9 0*2:1dq8.rgt/0.1 0*2:4fb/1',
    '0*2:1dq8.rgx/0.1 0*m:4fd/1 0:1dq8.rhl 0*6:4fz/1 0:4g6 0:1dq8.rht 0*2:4g7/1 0:1dq8.rhw 0*2:4g9/2',
    '0*3:4gc/1 0*2:1dq8.ri2/0.1 0: 0*7:4gf/1 0*3:1dq8.ric/0.1 0*2:4gm/1 0*2:1dq8.rih/0.1 0*3:4go/1',
    '0*8:1dq8.rim/0.1 0*2:4gr/1 0*4:1dq8.riw/0.1 0*2:4fr/1 0:1dq8.rj2 0*2:4g5/-x 0:4fa',
    '0*4:1dq8.rj6/0.1 0*a:2sp/1 0*2:nl/3sp 0*g:1dq8.rjm/0.1 0: 0:4gt 0:1dq8.rk4 0*6:4gu/1',
    '0*3:1dq8.rkb/0.1 0*3:4h0/1 0:1dq8.rkh 0*4:4h3/1 0*3:1dq8.rkm/0.1 0*2:4h7/1 0:1dq8.rkr 0:4h9',
    '0:1dq8.rkt 0*2:4ha/1 0*3:1dq8.rkw/0.1 0*2:4hc/1 0*3:1dq8.rl1/0.1 0*3:4he/1 0*3:1dq8.rl7/0.1',
    '0*8:4hh/1 0:1dq8.rli 0*3:4hp/1 0*4:1dq8.rlm/0.1 0*5:4hs/1 0*3:1dq8.rlv/0.1 0*3:4hx/1 0:1dq8.rm1',
    '0*4:4i0/1 0*9:1dq8.rm6/0.1 0:4i4 0*f:1dq8.rmg/0.1 0*9:2sq/1 0*3:2q1/1 0*6:nm/1 0*2:2s5/-24d',
    '0*6:1dq8.rnf/0.1 0*3: 0:1dq8.rno 0*7:4i5/1 0:4id 0:1dq8.rnx 0*3:4if/1 0:1dq8.ro1 0*n:4ii/1',
    '0:1dq8.rop 0*a:4j5/1 0:1dq8.rp0 0*5:4jf/1 0*4:1dq8.rp6/0.1 0*7:4jk/1 0:1dq8.rph 0*3:4jr/1',
    '0:1dq8.rpl 0*4:4ju/1 0*7:1dq8.rpq/0.1 0*2:4jy/1 0*9:1dq8.rpz/0.1 0*2:4ic/2 0*4:1dq8.rqa/0.1',
    '0*a:2sp/1 0*i:1dq8.rqo/0.1 0*2: 0:1dq8.rr8 0*7:4k0/1 0:4k8 0:1dq8.rrh 0*3:4ka/1 0:1dq8.rrl',
    '0*n:4kd/1 0:1dq8.rs9 0*9:4l0/1 0:4lf 0:1dq8.rsk 0*5:4l9/1 0*2:1dq8.rsq/0.1 0: 0*2:4le/3',
    '0*6:4li/1 0:1dq8.rt1 0*3:4lo/1 0:1dq8.rt5 0*4:4lr/1 0*7:1dq8.rta/0.1 0*2:4lv/1 0*7:1dq8.rtj/0.1',
    '0:4lg 0:1dq8.rtr 0*2:4k7/2 0*4:1dq8.rtu/0.1 0*a:2sp/1 0*i:1dq8.ru8/0.1 0*2: 0:1dq8.rus 0*7:4lx/1',
    '0:4m5 0:1dq8.rv1 0*3:4m7/1 0:1dq8.rv5 0*n:4ma/1 0:1dq8.rvt 0*g:4mx/1 0*4:1dq8.rwa/0.1 0*6:4nd/1',
    '0*2:1dq8.rwk/0.1 0*3:4nj/1 0:1dq8.rwp 0*4:4nm/1 0*9:1dq8.rwu/0.1 0:4nq 0*8:1dq8.rx4/0.1',
    '0*2:4m4/2 0*4:1dq8.rxe/0.1 0*a:2sp/1 0*i:1dq8.rxs/0.1 0*2: 0:1dq8.ryc 0*i:4nr/1 0*3:1dq8.ryv/0.1',
    '0*o:4o9/1 0:1dq8.rzm 0*9:4ox/1 0:1dq8.rzw 0:4p6 0*2:1dq8.rzy/0.1 0*7:4p7/1 0*3:1dq8.s07/0.1',
    '0:4pe 0*4:1dq8.s0b/0.1 0*6:4pf/1 0:1dq8.s0l 0:4pl 0:1dq8.s0n 0*8:4pm/1 0*i:1dq8.s0w/0.1',
    '0*2:4pu/1 0:l7 0*c:1dq8.s1h/0.1 0*1m:4pw/1 0*4:1dq8.s3f/0.1 0*2:2s6/1zc 0*5:4rj/1 0:2rn 0*5:',
    '0*2:4ro/1 0: 0*2:nt/24w 0*9:2sq/1 0*2:l8/1 0*11:1dq8.s4c/0.1 0*2:4rq/1 0:1dq8.s5f 0:4rs',
    '0*2:1dq8.s5h/0.1 0*2:4rt/1 0:1dq8.s5l 0:4rv 0*2:1dq8.s5n/0.1 0:4rw 0*6:1dq8.s5q/0.1 0*4:4rx/1',
    '0:1dq8.s60 0*7:4s1/1 0:1dq8.s68 0*3:4s8/1 0:1dq8.s6c 0:4sb 0:1dq8.s6e 0:4sc 0*2:1dq8.s6g/0.1',
    '0*2:4sd/1 0:1dq8.s6k 0*d:4sf/1 0:1dq8.s6y 0*3:4ss/1 0*2:1dq8.s72/0.1 0*5:4sv/1 0:1dq8.s79 0:2ro',
    '0:1dq8.s7b 0*4: 0*2:4t0/1 0*2:1dq8.s7i/0.1 0*a:2sp/1 0*2:1dq8.s7u/0.1 0*2:4se.4s1/0.7',
    '0*y:1dq8.s7y/0.1 0:4uy.4vh 0*3:nu/1 0*8:la/1 0*7:lh/1 0*2:nx/-7l 0*3:ny/1 0*2: 0*6:o1/1',
    '0*a:2sp/1 0*9:2sq/1 0*2:2sp/-24i 0: 0:o8 0: 0:o9 0: 0*4:i6/1 0*2:oa/1 0*3:4t2/2 0:4t6.4ux',
    '0*4:4t8/2 0:1dq8.saw 0*4:4tg/2 0:4tm.4ux 0*4:4to/2 0:4tu.4ux 0*4:4tw/2 0:4u2.4ux 0*4:4u4/2',
    '0:4ua.4ux 0*c:4uc/2 0:4t2.4ut 0:4um 0*6:1dq8.sbv/0.1 0*3:4v4/1 0*a:4v9/1 0*2: 0*2:4v7/1 0*2:',
    '0*2:4vj/-49v 0*2: 0*4:4v0/1 0*4:1dq8.scs/0.1 0*3:4t3/2 0:4t7.4ux 0*4:4t9/2 0:1dq8.sd4 0*4:4th/2',
    '0:4tn.4ux 0*4:4tp/2 0:4tv.4ux 0*4:4tx/2 0:4u3.4ux 0*4:4u5/2 0:4ub.4ux 0*c:4ud/2 0:4t3.4ut',
    '0*2:4ud/8 0:4un 0:1dq8.se5 0*8:oc/1 0: 0*6:ok/1 0*2:1dq8.sel/0.1 0:oq 0*1c:1dq8.seo/0.1',
    '0*u:4z5/1 0*4:501/1 0:1dq8.sgy 0*5:505/1 0:1dq8.sh4 0*2:50a/1 0:1dq8.sh7 0*7:50g/1',
    '0*3:1dq8.shf/0.1 0*3: 0:50r 0*6:1dq8.shm/0.1 0*a:2sp/1 0*2:h8/1 0*4:lq/1 0*2:4zz/1 0*4:50c/1',
    '0*4:50n/1 0*1y:1dq8.sii/0.1 0*7:3q9/1 0*6:3qh/1 0*6:3qo/1 0*c:3qv/1 0*2:3r8/1 0*3:3qg/7',
    '0*2:3r7/3 0*a:1dq8.sli/0.1 0*7:3q9/1 0*6:3qh/1 0*6:3qo/1 0*c:3qv/1 0*2:3r8/1 0*3:3qg/7 0*2:3r7/3',
    '0*3:3rb/1 0*2:1dq8.smx/0.1 0:hd 0*4:1dq8.sn0/0.1 0*2i:5sy/1 0*5:1dq8.spm/0.1 0*1w:5vg/1',
    '0*5:1dq8.srn/0.1 0*2a:5xc/1 0*6:1dq8.su2/0.1 0*7:3z0/1 0:1dq8.suf 0*1r:3z7/1 0:1dq8.sw7 0:40y',
    '0:1dq8.sw9 0*4:40z/1 0*2:1dq8.swe/0.1 0*7:413/1 0:1dq8.swn 0:41a 0:1dq8.swp 0*4:41b/1',
    '0*2:1dq8.swu/0.1 0*13:41f/1 0:1dq8.sxz 0:42i 0:1dq8.sy1 0*4:42j/1 0*2:1dq8.sy6/0.1 0*v:42n/1',
    '0:1dq8.sz3 0:43i 0:1dq8.sz5 0*4:43j/1 0*2:1dq8.sza/0.1 0*7:43n/1 0:1dq8.szj 0:43u 0:1dq8.szl',
    '0*4:43v/1 0*2:1dq8.szq/0.1 0*7:43z/1 0:1dq8.szz 0*7:446/1 0:1dq8.t07 0*n:44d/1 0:1dq8.t0v',
    '0*v:450/1 0:1dq8.t1r 0:45v 0:1dq8.t1t 0*4:45w/1 0*2:1dq8.t1y/0.1 0*7:460/1 0:1dq8.t27 0*13:467/1',
    '0:1dq8.t3b 0*j:47a/1 0*6:1dq8.t3v/0.1 0*2:g5/t 0*4:g6/1 0*2:gq/o 0*9:2sq/1 0*b:2q4/1',
    '0*z:1dq8.t4t/0.1 0*2d:57d/1 0*c:1dq8.t85/0.1 0*aj:59q/1 0*2:5ln/-1e 0*g:5kb/1 0*8:5ks/1',
    '0*h:5l6/1 0*5i:5lo/1 0*2:ly/-4x 0*2:5ka/h 0*6:5l0/1 0*9:1dq8.tpz/0.1 0*2:ei/5co 0*p:5r7/1',
    '0*2:ia/1 0*3:1dq8.tr1/0.1 0*2:5rw 0*2:5rx/s 0*2:5rx 0*2:5ry 0*2:5rz 0*2:5sn/1 0*3:5rz 0*4:5s0/1',
    '0*4:5s3 0*2:5s4/o 0*2:5s5/1 0*3:5s6 0*3:5s7 0*2:5s8 0*2:5s9 0*2:5sa 0*4:5sb/1 0*4:5se 0*3:5sf',
    '0*3:5sg 0*2:5sc/5 0*3:5si 0*2:5sj 0*2:5sk 0*2:5sl/1 0*2:5sq/4 0*2:5sv/-4 0*2:5st/3 0*3:5sx',
    '0*2:5s5/9 0*3:ge/1 0*2:5sa.5sj/8.-1 0*2:5ry.5ry/17ya.o1f 0*e:1dq8.tte/0.1 0*d:4wy/1 0:1dq8.tu5',
    '0*7:4xb/1 0*b:1dq8.tud/0.1 0*l:4xi/1 0*2:h6/1 0*9:1dq8.tvb/0.1 0*k:4y3/1 0*c:1dq8.tw4/0.1',
    '0*d:4yn/1 0:1dq8.twt 0*3:4z0/1 0:1dq8.twx 0*2:4z3/1 0*c:1dq8.tx0/0.1 0*z:50s/1 0*z:51s/1 0*c:',
    '0:52r 0: 0*2:ha/1 0*2:gd/5h 0*3:lv/1 0*2:2s7/29k 0: 0*2:1dq8.tzy/0.1 0*a:2sp/1 0*6:1dq8.u0a/0.1',
    '0*a:2sp/1 0*6:1dq8.u0q/0.1 0*2:l4/-4a 0*2:fp/1a 0*2:ga/1 0*2:f7/1 0*2:fq/1a 0:l5 0*4: 0:1dq8.u1b',
    '0*a:2sp/1 0*6:1dq8.u1m/0.1 0*2:53z/2 0*2:544/6 0*2:54c/3 0*2:54h/3 0*2:54l/1 0*2:54r/2 0*2:54w/2',
    '0*2:553/2 0*2:556/1 0*3:55e/3 0*2:55p/4 0*3:55w/2 0*2:563/5 0*2:569/3 0*2:56g/3 0*3:56k/1',
    '0*2:53y/4 0*2:545/6 0*2:54d/3 0*3:54i/5 0*2:54u/3 0*2:54z/5 0*3:55f/3 0*2:55q/k 0*3:55u/5',
    '0*2:56e/3 0*2:56n/1 0*2:55n/-1k 0*2:546/3 0*2:54j/-5 0*2:54o/1h 0*2:550/2 0*2:54v/d 0*2:55g/3',
    '0*2:55r/a 0*2:56f/3 0*2:56b/2 0*2:56p/-13 0*2:55v/-1o 0*2:566/-9 0*2:562/-a 0*8:1dq8.u48/0.1',
    '0*7:53r/1 0*2:540/8 0*2:567/-1i 0*2:55o/12 0*2:56s/1 0*2:56v/1 0*2:56z/2 0*4:572/2 0*2:579/-c',
    '0*2:577/-26 0*2:54q/j 0*2:55a/1h 0*2:56u/4 0*2:570/-1p 0*2:575/-1t 0*2:55d/1x 0*2:57b/-8 0:57c',
    '0*2e:1dq8.u5m/0.1 0*t:4vk/1 0*3:1dq8.u8t/0.1 0*c:4wd/1 0*4:1dq8.u98/0.1 0*9:4wp/1 0*3:',
    '0*4:1dq8.u9o/0.1 0:lp 0*3:1dq8.u9t/0.1 0*2:gk/7 0*a:2sp/1 0*u:52s/1 0*2:1dq8.ub2/0.1 0*5:53m/1',
    '0*2z:1dq8.ub9/0.1 0*w:or/1 0*lc:1dq8.uf4/0.1 0*2:2t3/5 0*2:2t9/q 0*2:2uc/d 0*2:2ve/5 0*2:2w8/2n',
    '0*2:2z8/h 0*2:30a/11 0*2:31p/p 0*2:32u/-f 0*2:32v/-6 0*2:32k/q 0*2:32w/1 0*2:33f/t 0*2:34d/1l',
    '0*3:36r/1 0*3:37f/d 0*2:38u/l 0*2:3ay/1 0*2:3cb/c 0*2:3ct/4 0*2:3d4/4s 0*2:2sz/5 0*2:2tm/c',
    '0*2:2ul/u 0*2:2vk/1d 0*2:2xt/q 0*2:2z4/h 0*2:2zy/19 0*2:31g/8 0*2:32a/w 0*2:33b/p 0*2:35u/t',
    '0*2:381/-f2 0*2:2ta/4 0*2:2t9/d 0*2:2ul/u 0*2:2vo/4 0*2:2w8/p 0*2:2yv/q 0*2:317/z 0*2:32a/g',
    '0*2:32w/1 0*2:33b/2j 0*2:36n/5 0*2:37b/d 0*2:3az/1a 0*2:3ca/2 0*2:3d1/1 0*2:2yj/5h 0*2:36n/11',
    '0*2:3c9/1 0*2:3cw/5 0*2:3d2/-68 0*44:1dq8.v3g/0.1 0*2:2sz 0*6:2tm 0*2:2u8 0*a:2ul 0*a:2vf',
    '0*2:2wp 0*2:2wx 0*a:2xt 0*4:2yj 0*6:2zl 0*8:2zy 0*6:317 0*8:31g 0*8:32a 0*4:33b 0*8:340 0*a:356',
    '0*8:35u 0*a:36n 0*4:37o 0*a:381 0*4:38a 0*2:38e 0*6:38q 0*2:2xt/81 0*2:381/d 0:2sz.3ar 0:356',
    '0*4:1dq8.vbw/0.1 0*o:2sz 0*g:2vf 0*4:2yj 0*o:32a 0*e:36n 0*8:38e 0*6:1dq8.vei/0.1 0*g:3c8',
    '0*6:3cd 0*2:1dq8.vfa/0.1 0*6:3cd 0*2:1dq8.vfi/0.1 0*g:3ch 0*g:3cj 0*6:3cr 0*2:1dq8.vgm/0.1',
    '0*6:3cr 0*2:1dq8.vgu/0.1 0*8:3d0 0:1dq8.vh4 0:3d0 0:1dq8.vh6 0:3d0 0:1dq8.vh8 0:3d0 0:1dq8.vha',
    '0*2:3d0/5 0*f:3d5 0*2:3c8 0*2:3cd 0*2:3ch 0*2:3cj 0*2:3cr 0*2:3d0 0*2:3d5 0*2:1dq8.vi6/0.1',
    '0*g:3c8 0*g:3ch 0*g:3d5 0*5:3c8 0:1dq8.vjp 0*7:3c8 0*2:ev/2xo 0*2:ev/6 0*2:es/2xp 0*2:3ch',
    '0:1dq8.vk5 0*2:3ch 0*2:3cd 0*3:3ch 0*3:ev 0*4:3cj 0*2:1dq8.vkk/0.1 0*6:3cj 0:1dq8.vks 0*3:ew',
    '0*4:3d0 0*2:3cw 0*6:3d0 0*2:3cw/-2y4 0*2:es/-8 0*2:1dq8.vlc/0.1 0*3:3d5 0:1dq8.vlh 0*2:3d5',
    '0*2:3cr 0*3:3d5 0*2:el/b 0:1dq8.vlr 0*b:eh 0*5: 0*2:f9 0*4:fa/1 0*2:tu/-eu 0*4:hk/1 0*4:hr/1',
    '0*4:k8/1 0:gt 0:gt.gt 0:gt.gt.gt 0*2:kc/-5x 0:eg 0*5: 0*2:eh/5o 0*2:k6/a 0:kg.kg 0:kg.kg.kg 0:kh',
    '0:kh.kh 0:kh.kh.kh 0*2:kk/-2w 0*2:hp/2w 0:gh.gh 0*2:gs/-23 0*3:km/2 0*2:kr/-e 0*2:jx/-1l 0:id',
    '0*2:gl.gl/0.-4 0:gh.gl 0*2:k1/-d 0*2:ke/1 0*2:jt/-3x 0*2:kp/-v 0*2:k7/-4t 0:kn 0*2:1dq8.vo5/0.1',
    '0:kg.kg.kg.kg 0*7:1dq8.vo8/0.1 0:eh 0*4: 0*6:1dq8.vok/0.1 0*6: 0*2:2sp/5u 0*2:1dq8.voy/0.1',
    '0*6:2st/1 0*2:tk/c 0*2:tp/-bp 0*2:i1/2jf 0*a:2sp/1 0*2:tk/c 0*2:tp/-bp 0:i1 0*h:1dq8.vpr/0.1',
    '0*8:2s8/1 0:340.356 0*9:2sg/1 0*u:1dq8.vqq/0.1 0*r: 0*l:1dq8.vsb/0.1 0*2:2sz.jw.2u8/0.0.ay 0:2u8',
    '0:ne.2u8 0:pn 0*2:2u8.jw.32a/0.0.4d 0*2:2vs/-264 0:ne.2wp 0*2:2wx/w 0*3:2xt 0*2:2y5/e 0*2:2yj/1f',
    '0*2:2zy/-2a9 0:31g 0:31g.32a 0*2:pq/1 0*2:33b/d 0*3:340 0*2:ps/1 0:356.317 0:35u.2vf.2zy',
    '0:35u.317 0*2:pu/2iw 0*2:pv/2na 0*2:pw/2iu 0*2:px/29o 0*2:2sz/n 0*2:2u8/-24a 0*2:2vf',
    '0*2:2wp/-26q 0*2:317/13 0*4:3sh/1 0*2:2yj/-28j 0:2wp.2sz.38a 0:1dq8.vuk 0*2:3ca 0*2:3cs/-2j9',
    '0*4:q1/1 0*2:2ul 0*2:2vf/34 0*2:2z4/-28z 0:k0 0*7:1dq8.vv0/0.1 0*2:2sq.jx.2ss/1.0.0',
    '0*4:2sq.jx.2su/1.0.0 0*2:2sq.jx.2sv/4.0.0 0*4:2sq.jx.2sx/2.0.0 0:2sq.jx 0:2yj 0:2yj.2yj',
    '0:2yj.2yj.2yj 0:2yj.37o 0:37o 0:37o.2yj 0:37o.2yj.2yj 0:37o.2yj.2yj.2yj 0:2yj.38a 0:38a',
    '0:38a.2yj 0:38a.2yj.2yj 0*2:2zy/-5q 0*2:2ul/6m 0:2yj 0:2yj.2yj 0:2yj.2yj.2yj 0:2yj.37o 0:37o',
    '0:37o.2yj 0:37o.2yj.2yj 0:37o.2yj.2yj.2yj 0:2yj.38a 0:38a 0:38a.2yj 0:38a.2yj.2yj 0*2:2zy/-5q',
    '0*2:2ul/6m 0*4:2qf/1 0*c:1dq8.vwk/0.1 0*2:q6/2 0*2:q7/2 0*6:qa/1 0*2:q6/1 0*i:qg/1 0*2:qa/o',
    '0*u:qz/1 0*3:rw/-2 0*1f:rt/1 0*5:t7/1 0*3:tb/1 0*2:td/1 0*4:tg/1 0*i:tw/1 0*2:ud/1 0*6:ue/1',
    '0:uj.uj 0:uj.uj.uj 0:uk 0:uk.uk 0:uk.uk.uk 0*g:ul/1 0*2:uw/5 0*2:v2 0*2:v3/1 0*2:v3/2 0*n:v5/1',
    '0*2:tp/23 0*b:vs/1 0*2:v9/-1l 0*2:tq/24 0*2:vv/8 0*2:w4/-1 0*3:w4/1 0*8:w5/1 0*2:w7/1 0*2:wd/1',
    '0*4:wd/1 0*10:wf/1 0*2:x5/6 0*2:xc/2 0*1c:xf/1 0*2:w9/1 0*2:wo/1 0*6:yr/1 0*4:xh/1 0*1n:yx/1',
    '0*2:j2/1 0*4m:10k/1 0*1b:1dq8.wcx/0.1 0*13:156/1 0*p:1dq8.wfb/0.1 0*b:169/1 0*l:1dq8.wgb/0.1',
    '0*9:2sq/1 0*a:2sq.2sp/0.1 0:2sr.2sp 0*9:i0.2sq.i1/0.1.0 0*a:i0.2sq.2sp.i1/0.0.1.0',
    '0:i0.2sr.2sp.i1 0*9:2sq.gt/1.0 0*a:2sq.2sp.gt/0.1.0 0*2:2sr.2sp.gt/-2ar.a.18 0*2:i0.2tm.i1/0.m.0',
    '0*2:i0.2ul.i1/0.u.0 0*2:i0.2wp.i1/0.8.0 0*2:i0.2xt.i1/0.q.0 0*2:i0.2z4.i1/0.h.0',
    '0*2:i0.2zy.i1/0.19.0 0*2:i0.31g.i1/0.u.0 0*2:i0.33b.i1/0.d.0 0*2:i0.340.i1/0.16.0',
    '0*2:i0.35u.i1/0.t.0 0*2:i0.37o.i1/0.d.0 0*2:i0.38a.i1/0.4.0 0:i0.38q.i1 0*2:2sz/n 0*2:2u8/d',
    '0*2:2vf/1a 0*2:2wx/w 0*2:2yj/l 0*2:2zl/d 0*2:317/9 0*2:32a/11 0*2:33o/c 0*2:356/o 0*2:36n/11',
    '0*2:381/9 0*2:38e/c 0*2:2sz/n 0*2:2u8/d 0*2:2vf/1a 0*2:2wx/w 0*2:2yj/l 0*2:2zl/d 0*2:317/9',
    '0*2:32a/11 0*2:33o/c 0*2:356/o 0*2:36n/11 0*2:381/9 0*2:38e/c 0:2sp 0*9:2sq.2sq/0.1 0:2sr.2sp',
    '0*9:2sq/1 0:2sq.2sp 0*2:2sp/-1m5 0*7r:16l/1 0:1dq8.wt4 0*n:1ec/1 0*8:27j/1 0*1h:1ez/1 0*3:2ln/1',
    '0*e:1gg/1 0*2:1dq8.wvy/0.1 0*a:1gu/1 0*6:27d/1 0*2:1h4/1 0*e:1dq8.wwi/0.1 0*2:1h6/1',
    '0*2n:1dq8.wwy/0.1 0*4:1h8/1 0:1dq8.wzp 0*4:1hc/1 0*2:1dq8.wzu/0.1 0*s:1hg/1 0:1dq8.x0o 0*z:1i8/1',
    '0:1dq8.x1o 0:1j7 0:1dq8.x1q 0*4:1j8/1 0*3:1dq8.x1v/0.1 0:1jc 0:1dq8.x1z 0*7:1jd/1',
    '0*2:1dq8.x27/0.1 0*l:1jk/1 0*9:2sq/1 0:2sq.2sp 0*9:2sq/1 0:2sq.2sp 0*9:2sq/1 0:2sq.2sp 0:1k5',
    '0*3:1dq8.x3p/0.1 0*o:1k6/1 0:1dq8.x4g 0*e:1ku/1 0*h:1dq8.x4v/0.1 0*s:1l8/1 0*4:1dq8.x64/0.1',
    '0*g:1m0/1 0*74:209/1 0*3n:1mg/1 0*m:ig/1 0*2r:1q3/1 0*2:ie/1 0*e:1su/1 0:uj.uj.uj.uj 0*2v:1t8/1',
    '0:fx.fx.tp 0:tp.tp 0:tp.tp.tp 0*2u:1w3/1 0*1d:1yw/1 0*oi:1dq8.xse/0.1 0*2:1dmo.14qe/0.11o',
    '0*3:1dmo.14rf/0.-1 0*2:1dmo.14u3/0.jr 0*2:1dmo.15gg/0.w 0*2:1dmo.15he/0.9m 0*2:1dmo.15rd/0.1pi',
    '0*2:1dmo.17gv/0.j 0*2:1dmo.17hf/0.-1 0*2:1dmo.17hf/0.cw 0*2:1dmo.17y2/0.5z 0*2:1dmo.1840/0.38',
    '0*2:1dmo.1877/0.i1 0*2:1dmo.199x/3k.-asb 0*2:1dmo.19ep/0.4 0*2:1dmo.19mw/0.vm 0*2:1dmo.1akt/0.1w',
    '0*2:1dmo.1anp/0.5 0*2:1dmo.1bho/0.cf 0*2:1dmo.1bu3/0.-73z 0*2:1dmo.1bvf/0.2a 0*2:1dmo.1c3v/0.e8',
    '0*2:1dmo.1cry/0.gc 0*2:1dmo.1d8b/0.ce 0*2:1dmo.1dyx/0.bq 0*2:1dmo.1efn/0.-1 0*2:1dmo.1efn',
    '0*2:1dmo.1efm/0.1k 0*2:1dmo.1eh6/0.1 0*2:1dmp.paa/0.3i 0*2:1dmp.pdr/0.a 0*2:1dmp.poc/0.3h',
    '0*2:1dmp.prt 0*2:1dmp.qj2/0.eu 0*2:1dmp.r5s/0.-1 0*2:1dmp.r7l/0.h 0*2:1dmp.r82/0.cu',
    '0*2:1dmp.rvh/0.46 0*2:1dmp.sbq/0.28 0*2:1dmp.sdy 0*2:1dmp.sk1/0.s4 0*2:1dmp.tiv/0.1',
    '0*2:1dmp.tj3/0.2x 0*2:1dmp.tng/0.1 0*2:1dmp.tt4/0.2y 0*2:1dmp.u06/0.3z 0*2:1dmp.u6m/0.g',
    '0*2:1dmp.u73/0.1 0*2:1dmp.u74/0.3n 0*2:1dmp.uc6/0.5y 0*2:1dmp.ujs/0.44 0*2:1dmp.uws/0.bn',
    '0*2:1dmp.vat/0.1d 0*2:1dmp.vd0/0.1m 0*2:1dmp.vgq/0.6 0*2:1dmp.vgy/0.19 0*2:1dmp.vil/0.c',
    '0*2:1dmp.vj0 0*2:1dmp.vj3/3j.311 0*b:1dq8.yk5/0.1 0*2:1dmo.14ow/0.14 0*2:1dmo.14qe/0.9',
    '0*2:1dmo.14rd/0.18 0*2:1dmo.14ss/0.k 0*2:1dmo.14u2/0.hx 0*2:1dmo.15d1/0.6 0*2:1dmo.15du/0.k',
    '0*2:1dmo.15ez/0.1h 0*2:1dmo.15h1/0.b 0*2:1dmo.15ln/0.2m 0*2:1dmo.15p1/0.5 0*2:1dmo.15q0/0.9',
    '0*2:1dmo.15r0/0.d 0*2:1dmo.15s2/0.1g 0*2:1dmo.15u0/0.r 0*2:1dmo.16fr/0.20 0*2:1dmo.16uj/0.n',
    '0*2:1dmo.16ve/0.b 0*2:1dmo.16w7/0.24 0*2:1dmo.17bk/0.1c 0*2:1dmo.17g8/0.n 0*2:1dmo.17he/0.m',
    '0*2:1dmo.17ji/0.3 0*2:1dmo.17tn/0.a 0*2:1dmo.17u9/0.d 0*2:1dmo.17xu/0.8 0*2:1dmo.17y7/0.39',
    '0*2:1dmo.181q/0.d 0*2:1dmo.182b/0.1p 0*2:1dmo.184h/0.i 0*2:1dmo.1877/0.g5 0*2:1dmo.18om/0.l',
    '0*2:1dmo.199r/0.5 0*2:1dmo.19c7/0.g 0*2:1dmo.19d0/0.l 0*2:1dmo.19eo/0.5 0*2:1dmo.19m8/0.o',
    '0*2:1dmo.19ns/0.s8 0*2:1dmo.1ahu/0.n 0*2:1dmo.1ak3/0.o 0*2:1dmo.1al0/0.7 0*2:1dmo.1amn/0.5',
    '0*2:1dmo.1ano/0.tz 0*2:1dmo.1bu2/0.c 0*2:1dmo.1buj/0.4 0*2:1dmo.1buv/0.i 0*2:1dmo.1bvf/0.29',
    '0*2:1dmo.1c3o/0.5 0*2:1dmo.1cd8/0.a 0*2:1dmo.1cew/0.7 0*2:1dmo.1cfc/0.8 0*2:1dmo.1ci3/0.7',
    '0*2:1dmo.1com/0.7 0*2:1dmo.1cq6/0.h 0*2:1dmo.1cry/0.6l 0*2:1dmo.1cyq/0.h 0*2:1dmo.1d8a/0.3i',
    '0*2:1dmo.1dby/0.52 0*2:1dmo.1djf/0.1a 0*2:1dmo.1dv7/0.3p 0*2:1dmo.1eeu/0.r 0*2:1dmo.1eh6/0.1f',
    '0*2:1dmp.pa9/0.b 0*2:1dmp.paq/0.x 0*2:1dmp.pdr/0.a 0*2:1dmp.pnn/0.7 0*2:1dmp.po3/0.9',
    '0*2:1dmp.pos/0.f 0*2:1dmp.ppb/0.27 0*2:1dmp.prm/0.6 0*2:1dmp.qj1/0.u 0*2:1dmp.qww/0.c',
    '0*2:1dmp.qxv/0.7v 0*2:1dmp.r63/0.1z 0*2:1dmp.r9c/0.fr 0*2:1dmp.rpi/0.f 0*2:1dmp.rqw/0.11',
    '0*2:1dmp.rxg/0.c 0*2:1dmp.rzn/0.6w 0*2:1dmp.s7e/0.5t 0*2:1dmp.sds/0.5 0*2:1dmp.sk1/0.54',
    '0*2:1dmp.ssm/0.6 0*2:1dmp.ssx/0.py 0*2:1dmp.tj4/0.4c 0*2:1dmp.trq/0.3 0*2:1dmp.tt4/0.2x',
    '0*2:1dmp.twe/0.4 0*2:1dmp.twp/0.2q 0*2:1dmp.u0d/0.6 0*2:1dmp.u0x/0.4n 0*2:1dmp.u6z/0.4',
    '0*2:1dmp.uc6/0.3 0*2:1dmp.ucs/0.70 0*2:1dmp.ul4/0.7 0*2:1dmp.un9/0.a 0*2:1dmp.unm/0.a',
    '0*2:1dmp.uoq/0.az 0*2:1dmp.vat/0.a 0*2:1dmp.vc5/0.m 0*2:1dmp.vcz/0.a 0*2:1dmp.vdd/0.14',
    '0*2:1dmp.vel/0.h 0*2:1dmp.vf7/0.d 0*2:1dmp.vgb/0.f 0*2:1dmp.vgy/0.1n 0*2:1dmp.vj0/0.4',
    '0*q:1dq8.yqe/0.1 0*c:2pb/1 0*4:1dq8.yrg/0.1 0*2:eh/1a 0*2:h2/3g 0*2:2pn/22 0:5zx.60j',
    '0*2:2sp/-29n 0*9:j3/1 0*2:2po/1 0*8:jc/1 0*2:ff/2g 0*2:hw/1 0*2:2pq/30 0*8:2sr/1 0*6: 0*2:fg/2cb',
    '0*2:2rr/1 0*2:2rs/1 0*2:2po/3 0*2:1dmo.15q9/0.3 0:1dmo.15qd 0:2rq 0:60g.5zy 0*2:kj/259 0:2pt',
    '0:1dq8.ytc 0*2:5zm 0*2:5zn 0*2:5zo 0*2:5zp 0*2:5zq 0*2:5zr 0*2:5zs 0*2:5zt 0*2:5zu 0*2:5zv',
    '0*2:5zw 0*2:5zx 0*2:5zy 0*2:5zz 0*2:600 0*2:601 0*2:602 0*3:603 0*2:604 0*2:605 0*6:606/1',
    '0*2:60b 0*3:60c 0*3:60d 0*3:60e 0*3:60f 0*6:60g/1 0*2:60l/1 0*2:60m/1 0*7:60n/1 0*5:60t/1',
    '0*3:5zo/3 0*2:1dq8.yvr/0.1 0*2: 0*2:f2/1 0*2:2ru 0:60n.60p 0*2:fh/5k5 0*2:5zm/1 0*2:5zn/1',
    '0*2:5zo/1 0*2:5zp/1 0*2:5zq/1 0*2:5zr/1 0*2:5zs/1 0*2:5zt/1 0*2:5zu/1 0*2:5zv/1 0*2:5zw/1',
    '0*2:5zx/1 0*2:5zy/1 0*2:5zz/1 0*2:600/1 0*2:601/1 0*2:602/1 0*2:603 0*2:604 0*2:605 0*6:606/1',
    '0*2:60b 0*3:60c 0*3:60d 0*3:60e 0*3:60f 0*6:60g/1 0*2:60l/1 0*2:60m/1 0*7:60n/1 0*5:60t/1',
    '0*3:5zo/3 0*4:60t/1 0*2:fi/2cd 0*2:2rw 0*2:5zv.605/17qd.syj 0*4:1dq8.yyp/0.1 0*4:60y/1 0*6:613/1',
    '0*4:61b/1 0*9:61g/1 0*2:61q/1 0*7:61t/1 0*2:621/4 0*3:626/1 0*2:612/7 0:61f 0*4:1dq8.yzx/0.1',
    '0*2:5sy/1 0*2:5xe/-4e 0*2:5xg/1 0*3:5t1/1 0*6:5xk/1 0*2:5to/-k 0*2:5t5/1 0*2:5tv/-o 0*9:5t8/1',
    '0*l:5vi/1 0*2:5vh/-1z 0*2:5tj/4o 0*2:5y8/4 0*2:5ye/5 0*2:5yn/2 0*2:5tq/53 0*2:5yv/-54 0*3:5ts/2',
    '0*2:5tx/4 0*2:5u3/2 0*4:5u6/1 0*2:5uc/4 0*2:5uq/7 0*2:5v2/4b 0*2:5ze/-41 0*2:5ve/1 0*2:5wh/1',
    '0*2:5wl/9 0*2:5wv/2 0*2:5x7/3 0:1dq8.z2n 0*2:2pu/1 0*2:1dmo.14ow/0.3w 0*2:1dmo.14p5/0.1qq',
    '0*2:1dmo.14p6/0.z 0*2:1dmo.14p7/0.7qf 0*2:1dmo.14rd/0.-1s 0*2:1dmo.14ox/0.27c',
    '0*2:1dmo.16i8/0.-1o6 0*2:60y/m 0*2:61c/-5 0*2:61s 0*2:61p/-1 0*2:627/-k 0*2:626/1 0*2:624/-u',
    '0*2:61t/2 0*2:622/1 0*2:620/6 0*2:60z/5 0*2:618/3 0*1k:1dq8.z3s/0.1 0*2:5zt/4 0*2:5zy/7',
    '0*2:608/3 0*4:60c/1 0*2:60i/6 0*4:60p/1 0*2:i0.5sy.i1/0.2.0 0*2:i0.5t1.i1/0.2.0',
    '0*2:i0.5t4.i1/0.1.0 0*2:i0.5t7.i1/0.2.0 0*2:i0.5ta.i1/0.2.0 0*4:i0.5td.i1/0.1.0',
    '0*2:i0.5sy.5vi.i1/0.2.0.0 0*2:i0.5t1.5vi.i1/0.2.0.0 0*2:i0.5t4.5vi.i1/0.1.0.0',
    '0*2:i0.5t7.5vi.i1/0.2.0.0 0*2:i0.5ta.5vi.i1/0.2.0.0 0*4:i0.5td.5vi.i1/0.1.0.0 0:i0.5ta.5vv.i1',
    '0:i0.5t9.5vq.5ta.5vm.5xf.i1 0:i0.5t9.5vq.5tg.5vv.i1 0:1dq8.z6n 0*2:i0.1dmo.14ow.i1/0.0.3w.0',
    '0*2:i0.1dmo.14p5.i1/0.0.1qq.0 0*2:i0.1dmo.14t0.i1/0.0.k9.0 0*2:i0.1dmo.14oz.i1/0.0.o8.0',
    '0*2:i0.1dmo.14rh.i1/0.0.ys.0 0*2:i0.1dmo.19mw.i1/0.0.1ur.0 0*2:i0.1dmo.1ano.i1/0.0.-zw.0',
    '0*2:i0.1dmp.ssx.i1/0.-1.dou.0 0*2:i0.1dmo.19et.i1/0.0.g5.0 0*2:i0.1dmo.19mx.i1/0.0.3lh.0',
    '0*2:i0.1dmo.15vx.i1/0.0.60c.0 0*2:i0.1dmp.rs1.i1/0.-1.lh8.0 0*2:i0.1dmo.15mc.i1/0.0.-r5.0',
    '0*2:i0.1dmo.15z0.i1/0.0.1d6.0 0*2:i0.1dmo.1crn.i1/0.0.-7vm.0 0*2:i0.1dmp.rt3.i1/0.-1.dxp.0',
    '0*2:i0.1dmo.1d9p.i1/0.0.-8d8.0 0*2:i0.1dmp.pnu.i1/0.0.9.0 0*c:1dq8.z7o/0.1 0:33b.35u.2vf',
    '0*9:2sr.2sq/0.1 0*6:2ss.2sp/0.1 0*2:5sy/2 0*2:5t1/2 0*2:5t4/1 0*2:5t7/2 0*2:5ta/2 0*4:5td/1',
    '0*2:5sy.5vi/2.0 0*2:5t1.5vi/2.0 0*2:5t4.5vi/1.0 0*2:5t7.5vi/2.0 0*2:5ta.5vi/2.0 0*4:5td.5vi/1.0',
    '0:5tc.5vi.5xr.5sy.5vq 0:5ta.5vv.5t9.5w1 0:1dq8.z9a 0:2pw 0*2:1dmo.14ow/0.3w 0*2:1dmo.14p5/0.1qq',
    '0*2:1dmo.14t0/0.k9 0*2:1dmo.14oz/0.o8 0*2:1dmo.14rh/0.ys 0*2:1dmo.19mw/0.1ur 0*2:1dmo.1ano/0.-zw',
    '0*2:1dmp.ssx/-1.dou 0*2:1dmo.19et/0.g5 0*2:1dmo.19mx/0.3lh 0*2:1dmo.15vx/0.60c',
    '0*2:1dmp.rs1/-1.lh8 0*2:1dmo.15mc/0.7qc 0*2:1dmo.1cfr/0.-5hg 0*2:1dmp.six/-1.csh',
    '0*2:1dmo.15rk/0.514 0*2:1dmp.u11/-1.avg 0*2:1dmo.15eh/0.53e 0*2:1dmo.14p6/0.z',
    '0*2:1dmo.14p7/0.34r 0*2:1dmo.15v7/0.-54 0*2:1dmo.17dj/0.-1d 0*2:1dmo.1crn/0.-7vm',
    '0*2:1dmp.rt3/-1.dxp 0*2:1dmo.16vw/-1atw.-1431 0*3:2ss.2sw/0.1 0*a:2st.2sp/0.1 0:2su.2sp',
    '0*9:2sq.1dmo.19mw/1.0.0 0*3:2sq.2sp.1dmo.19mw/0.1.0.0 0:2xt.2wx 0:2vf.340.2wx 0:2vf.37o',
    '0:2zy.35u.2ul 0*1b:5zm/1 0:1dq8.zcv 0*2:5zm.60b.2rv.605/0.f.38i.-j 0:5zm.60x.60e.5zm',
    '0:5zm.2rv.60q 0:5zn.607.60x.5zt 0*2:5zn.60x.602/1.-17.v 0:5zp.5zy.5zt.2rv.605 0:5zp.2rv.5zr.2rv',
    '0*2:5zq.60x.5zy/0.-392.k 0:5zr.5zn.60p 0*2:5zr.60o.603.605/0.4.m.-38a 0*2:5zr.60s.60x/0.5.-h',
    '0:5zs.5zr 0:5zs.607.2rv 0*2:5zs.60m.60p.2rv/0.4.-o.0 0:5zs.60s 0:5zs.60s.5zt.60o.60i',
    '0:5zs.60s.60j.2rv.605.60q 0:5zs.60s.60t.603.605 0:5zt.60o.60i',
    '0*2:5zt.60o.60i.605.60x/0.2.-j.-i.-5 0:5zt.60s.2rv.609 0*2:5zu.2rv.5zy/1.38v.8 0:5zv.2rv.60f',
    '0:5zw.5zn.5zt.60q 0:5zw.60x.602.2rv.60i 0:5zx.60p.60x.5zt 0*2:5zz.60x.602/0.0.3 0:601.2rv.5zy',
    '0*2:604.5zx/1.t 0*2:605.60x/1.-n 0*2:60a.603.605/1.-g.-2 0:60b.2rv.5zz.60x.605 0:60b.2rv.603',
    '0:60b.2rv.60r.60q 0:60c.5zm.5zy.605.60q 0:60c.5zt.60q 0*2:60c.5zv/0.v 0:60d.5zm.60o.603.605',
    '0:60d.5zn.2rv.605 0:60d.603.5zx.5zp.60q 0:60d.60o.60x 0:60e.5zt.601.2rv.60q 0:60e.600',
    '0*2:60e.607.60c/0.j.-9 0*2:60e.60x.5zy/0.-392.-1 0:60e.2rv.601 0:60f.5zn.60x.605 0:60f.60q.605',
    '0:60f.60x 0*2:60f.60x.605/0.-392.l 0:60f.2rv.60x 0:60g.5zn.5zt.60s 0*2:60g.5zn.60q/0.g.-f',
    '0:60g.60q.5zt 0:60g.60x.5zx.60n.60x 0:60h.5zt.60s.60x 0:60h.60p 0:60h.60p.60b.2rv.60q 0:60j.5zr',
    '0*2:60j.5zr.605.60x/0.-37w.0.-7 0*2:60l.2rv.605/0.0.l 0:60m.5zm.60x 0:60p.603.605.60q 0:60p.60o',
    '0:60q.60c.2rv 0:60q.2rv.60d.60q 0:60r.60i 0:60r.60x.605.5zu.60x 0*2:60t.603.605/-384.17ml.15jo',
    '0*9:2sq.1dmo.1bjt/1.0.0 0*a:2sq.2sp.1dmo.1bjt/0.1.0.0 0*5:2sr.2sp.1dmo.1bjt/0.1.0.0',
    '0:2xt.33b.2sz 0*2:2ul.2sz/-1m.do 0:2tm.2sz.340 0*2:32a.37o/11.-dg 0:2ul.317',
    '0*2:2ul.317.2sr/0.0.1 0:2yj.36n 0*2:1dmo.17xv.1dmo.18nk/0.1iy.0.-2o4',
    '0*2:1dmo.16w7.1dmo.1ahv/0.2jr.0.9k 0:1dmo.19uy.1dmo.1827.1dmo.14wq.1dmo.1d8e 0*2:33b.2sz/-1v.0',
    '0*2:3co.2sz/-bh.0 0*2:2zl.2sz/0.n 0*2:317.2tm/-4a.0 0:2u8.2sz.2zy 0:2zl.2u8.2sz.2zy',
    '0*2:33b.2wp/-1v.0 0*2:3co.2wp/0.8 0*2:317.2wx/-1m.0 0:2xt.38q 0*2:2zl.2xt.38q/1m.0.0',
    '0*2:2wx.2xt.38q/8x.0.0 0*2:3co.2zy/-bh.0 0*2:2ul.2zy/50.0 0*2:2wp.317/4r.0 0*2:3co.317/-bh.0',
    '0*2:2u8.317/5d.0 0*2:317.317.2sr/-6z.0.0 0:317.2sr 0*2:2zl.317.2sr/1m.0.1 0:2u8.317.2ss',
    '0:317.2ss 0*2:2zl.317.2ss/1m.-278.ce 0:317.tz.356.2sr 0:33b.2sz 0*2:2zl.33b.2sz/1m.0.0',
    '0*2:2wx.33b.2sz/73.-ac.1m 0:340.2sz.2ul.tz.356 0:340.2sz.2ul.tz.356.2sr 0*2:33b.356/-1v.0',
    '0*2:3co.356/-bh.0 0*2:33b.37o/-1v.0 0*2:3co.37o/-bh.0 0*2:2zl.37o/1m.0 0*2:33b.381/-1v.0',
    '0*2:3co.381/-bh.0 0*2:2zl.381/1m.0 0*2:2zl.3d5/1m.0 0:2sz.gt.317.gt 0*2:2tm.33o/m.-9g 0:2u8.2ul',
    '0:2u8.tz.2zl.2wx 0:2u8.32a.gt 0*2:2ul.2tm/2c.es 0*2:2xt.2sz/0.ac 0*2:2yj.31g/12.-1v',
    '0*2:2zl.317/0.4n 0*2:2zy.317/0.9 0:2zy.32a.2wx 0*2:2zy.38a/19.-eo 0*2:317.2yj.2zy/0.3r.0',
    '0:33b.2xt 0:33b.gt.317.gt 0:33b.33b.317 0*2:33b.340/1v.0 0*2:356.37o/2v.-e2',
    '0*2:37o.tz.317/-ep.0.0 0*9:2sq.1dmo.19et/1.0.0 0*a:2sq.2sp.1dmo.19et/0.1.0.0',
    '0*a:2sr.2sp.1dmo.19et/0.1.0.0 0*2:2ss.2sp.1dmo.19et/0.1.0.0 0:2wx.2sz.2zy 0*52u:1dog.zk0/0.1',
    '0*a:1dq8.14mu/0.1 0*1s:27r/1 0*9vk:1dmo.14ow/0.1 0*692:1dmp.pa8/0.1 0*2i:1dq9.vja/0.1 0*wd:629/1',
    '0*3:1dq9.wi5/0.1 0*1j:2by/1 0*a49:1dq9.wjr/0.1 1kw*4xs:1dq9.188w/0.1 0*2:1dmp.rpk/-1.hws',
    '0*2:1dmp.s7e/0.-ea 0*2:1dmo.1b69/0.-6fz 0*2:1dmo.15ut/1.-abt 0*2:1dmp.vj0/-1.bed',
    '0*2:1dmp.ssx/-1.ddi 0*2:1dmo.16x4/0.1pq 0*2:1dmo.1co9/0.1ss 0*2:1dmp.qin/0.aj 0*2:1dmp.r20/0.1hz',
    '0*2:1dmo.1a82/0.m1 0*2:1dmo.1bkp/0.lh 0*2:1dmp.q4d/0.2lp 0*2:1dmp.uep/-1.adt 0*2:1dmo.15rp/0.4nj',
    '0*2:1dmo.1btn/1.-lbi 0*2:1dmp.v8e/-1.che 0*2:1dmo.1be3/1.-kym 0*2:1dmp.r50/-1.hnp',
    '0*2:1dmp.pnc/0.18n 0*2:1dmo.180a/0.1n1 0*2:1dmo.1awa/0.13m 0*2:1dmp.slq/-1.ce0',
    '0*2:1dmo.15fb/0.87 0*2:1dmo.196s/0.173 0*2:1dmo.1btc/0.yf 0*2:1dmp.pa9/0.16t 0*2:1dmp.qjg/0.1hv',
    '0*2:1dmp.tv6/0.u5 0*2:1dmp.v7e/-1.hw2 0*2:1dmo.1da7/0.td 0*2:1dmp.q15/0.30b 0*2:1dmp.vb3/0.-3vt',
    '0*2:1dmo.16u7/0.17p 0*2:1dmo.1duo/1.-ogy 0*2:1dmo.1bvm/0.19k 0*2:1dmp.rsy/0.20l',
    '0*2:1dmo.16u0/0.p6 0*2:1dmo.1a8j/0.qv 0*2:1dmo.1b7z/0.2sg 0*2:1dmo.1e7r/1.-kj0',
    '0*2:1dmo.15n6/1.-g93 0*2:1dmo.15gc/0.-g 0*2:1dmo.1dek/0.pu 0*2:1dmp.q29/0.3no',
    '0*2:1dmp.rk0/-1.h8v 0*2:1dmo.1a82/1.-iro 0*2:1dmo.14qh/0.2pa 0*2:1dmo.189e/0.3ud',
    '0*2:1dmo.1chc/0.-6s9 0*2:1dmo.1d6j/0.-858 0*2:1dmo.186h/0.-3h8 0*2:1dmo.1arw/0.-1g4',
    '0*2:1dmo.1e02/0.-867 0*2:1dmo.16qm/0.61v 0*2:1dmp.q4p/0.19d 0*2:1dmo.1aka/1.-i6i',
    '0*2:1dmo.1aq0/0.-1vu 0*2:1dmp.put/-1.j3v 0*2:1dmo.1ch1/0.-7nb 0*2:1dmo.15d5/0.2o',
    '0*2:1dmo.19xd/0.412 0*2:1dmp.prj/0.1nn 0*2:1dmp.ssv/-1.cva 0*2:1dmo.15xe/0.10x',
    '0*2:1dmo.1818/0.1cp 0*2:1dmo.1bem/0.1t8 0*2:1dmp.tkd/0.xp 0*2:1dmp.vbr/0.1j 0*2:1dmo.15ln/0.3zf',
    '0*2:1dmo.1aif/1.-i6t 0*2:1dmo.17xw/0.m4 0*2:1dmo.18n4/0.ii 0*2:1dmo.1b8j/0.fa',
    '0*2:1dmo.1cax/0.11d 0*2:1dmo.1e5w/1.-osl 0*2:1dmp.s9y/0.-20o 0*2:1dmp.sgz/0.mf',
    '0*2:1dmo.15hz/0.3w 0*2:1dmo.160t/0.5jf 0*2:1dmp.r0i/0.dk 0*2:1dmo.1809/0.8c 0*2:1dmo.18xn/0.1mb',
    '0*2:1dmo.1dtq/0.-1qh 0*2:1dmo.14v8/0.1lh 0*2:1dmo.17fr/0.cz 0*2:1dmo.189o/0.3va',
    '0*2:1dmo.1ca1/0.27l 0*2:1dmp.pc6/0.3ji 0*2:1dmp.tti/0.2a 0*2:1dmp.u1k/-1.ayb',
    '0*2:1dmo.1dbi/1.-kje 0*2:1dmp.trs/-1.end 0*2:1dmo.14sm/0.gk 0*2:1dmo.17fy/0.29',
    '0*2:1dmo.19cp/0.vd 0*2:1dmo.1bri/0.vo 0*2:1dmp.q9o/0.29s 0*2:1dmp.vil/-1.e0r 0*2:1dmp.tny/-1.bx7',
    '0*2:1dmo.19q3/0.3c 0*2:1dmo.1av5/0.9n 0*2:1dmo.1c7d/0.9c 0*2:1dmo.1d2j/0.x1 0*2:1dmp.u3i/-1.b9r',
    '0*2:1dmo.18oe/1.-eye 0*2:1dmo.154b/0.2jy 0*2:1dmo.1azu/1.-ips 0*2:1dmo.185n/0.c9',
    '0*2:1dmo.19uf/0.29c 0*2:1dmp.tqe/-1.bs3 0*2:1dmo.15vz/0.1na 0*2:1dmo.19g3/0.8r',
    '0*2:1dmo.19yg/0.u5 0*2:1dmo.1c7a/0.d8 0*2:1dmo.1egp/1.-nfu 0*2:1dmp.r1d/0.1rf',
    '0*2:1dmp.tsy/-1.bx9 0*2:1dmo.1b5m/0.-599 0*2:1dmo.1brk/0.js 0*2:1dmp.qgq/0.3ah 0*2:1dmp.uvr/0.g8',
    '0*2:1dmo.19qv/0.184 0*2:1dmp.pns/-1.nvn 0*2:1dmo.1dls/0.aa 0*2:1dmo.1by8/0.-fb',
    '0*2:1dmp.riw/-1.dbc 0*2:1dmp.px2/-1.flw 0*2:1dmo.15hj/0.2hr 0*2:1dmo.18sz/0.54z',
    '0*2:1dmo.17d1/0.3h5 0*2:1dmo.19kk/1.-ha1 0*2:1dmp.qx8/0.2rl 0*2:1dmp.r63/-1.gug',
    '0*2:1dmo.15c0/0.w0 0*2:1dmp.1de6/0.1 0*2:1dmo.16qi/1.6nr 0*2:1dmo.19is/1.3vj',
    '0*2:1dmp.1dec/-1.-7xy 0*2:1dmo.1c16/0.ps 0*2:1dmo.1d8c/0.y 0*2:1dmo.1d9h/0.16',
    '0*2:1dmp.tw6/-1.k14 0*2:1dmo.1eil/1.-13y 0*2:1dmp.qhe/0.mxb 0*2:1dmp.rg8/0.lyj',
    '0*2:1dmp.1des/0.-kx8 0*2:1dmp.sn1/0.kru 0*2:1dmp.1dew/0.1 0*2:1dmp.u7j/0.d 0*2:1dmp.u94/0.wc',
    '0*2:1dq9.1df2/0.1 0*2:1dmo.150u/0.8p 0*2:1dmo.15cd/0.ak 0*2:1dmo.15no/0.31 0*2:1dmo.1671/0.2x',
    '0*2:1dmo.16co/0.d4 0*2:1dmo.16so/0.qk 0*2:1dmo.17ji/0.ti 0*2:1dmo.18iw/0.12 0*2:1dmo.18mq/0.nx',
    '0*2:1dmo.19eq/0.4v 0*2:1dmo.19xh/0.z6 0*2:1dmo.1b16/0.7c 0*2:1dmo.1bou/0.59 0*2:1dmo.1c82/0.vj',
    '0*2:1dmo.1d8e/0.b 0*2:1dmo.1d8o/0.8 0*2:1dmo.1d92/0.7 0*2:1dmo.1dal/0.1 0*2:1dmo.1dfk/0.1t',
    '0*2:1dmo.1dq8/0.fo 0*2:1dmo.1e6h/0.1k 0*2:1dmo.1egi/1.-p65 0*2:1dmp.pnx/0.3w 0*2:1dmp.prt/0.da',
    '0*2:1dmp.r2o/0.3q 0*2:1dmp.rgh/0.1k 0*2:1dmp.rtf/0.1h 0*2:1dmp.sdy/0.3m 0*2:1dmp.tsz/0.7w',
    '0*2:1dmp.u2j/3k.je8 0*44:1dq9.1dgs/0.1 0*2:2wp.2wp/0.1u 0:2wp.2zy 0*2:2wp.2wp.2yj/0.0.1f',
    '0*2:356.35u 0*c:1dq9.1dl3/0.1 0*2:3rx.3rz/0.-h 0*2:3rx.3ro/a.b 0*2:3rx.3rq/19yc.19tu',
    '0*4:1dq9.1dll/0.1 0:3sq 0: 0:3sq.3sq 0*2:3sw/-f 0*2:3sk/1 0*3:3sr/1 0*2:3t0/2 0*2:tk/2zh 0*3:3t1',
    '0*3:3sh 0*6:3si/1 0:1dq9.1dmf 0*3:3sp/1 0*2:3sr/1 0:1dq9.1dml 0:3st 0:1dq9.1dmn 0*2:3su/1',
    '0:1dq9.1dmq 0*2:3sx 0:1dq9.1dmt 0*5:3sy/1 0*2:3sm/-4 0*2:3sr/6 0:3sh.3ss 0*2:3t7 0*4:3tf 0*4:3tg',
    '0*4:3th 0*4:3tm 0*4:3tp 0*4:3tl 0*4:3vb 0*4:3vd 0*4:3ts 0*4:3tr 0*4:3tt 0*4:3tv 0*2:3u8 0*2:3u7',
    '0*2:3u9 0*2:3u3 0*2:3um 0*2:3uf 0*4:3vj 0*4:3vp 0*4:3vt 0*4:3vr 0*2:3w2 0*4:3w3 0*2:3wc 0*4:3w9',
    '0*4:3w8 0*4:3wu 0*x:1dq9.1dpu/0.1 0*4:3vn 0*2:3wh 0*2:3wg 0*2:3wi 0:3wh.3t3 0*2:3wl 0*2:3wf',
    '0*2:3wj 0*4:3ws 0*2:3wn 0*2:3tb.3tc 0*2:3tb.3wc 0*2:3tb.3wd 0*2:3tb.3wh 0*2:3tb.3wg 0*2:3tb.3wi',
    '0*3:3tb.3ws 0*3:3tb.3wn 0*4:3wp 0*2:3tb.3tq/0.6 0*2:3tb.3w0/0.n 0*2:3tb.3wo/3.-2y',
    '0*2:3te.3tw/0.1 0*2:3te.3w0/0.n 0*2:3te.3wo/5.-2y 0*2:3tj.3tw/0.1 0*2:3tj.3w0/0.n',
    '0*2:3tj.3wo/1.-2y 0*2:3tk.3w0/0.n 0*2:3tk.3wo/6.-2s 0*2:3tq.3w0/6.-2a 0*2:3tw.3w0/1.-2a',
    '0*2:3tx.3tw/0.24 0*2:3up.3tq/0.6 0*2:3up.3tx/0.23 0*2:3uv.3tw/0.24 0*2:3uw.3tq/0.6',
    '0*2:3uw.3tx/0.23 0*2:3v0.3tw/0.24 0*2:3v1.3w0/2.-2a 0*2:3v3.3w0/1.-2a 0*2:3v4.3w0/3.-2a',
    '0*2:3v7.3tw/0.1 0*2:3v7.3w0/0.n 0*2:3v7.3wo/8.-2s 0*2:3vf.3w0/0.n 0*2:3vf.3wo/3.-3c',
    '0*2:3vi.3tq/0.6 0*2:3vi.3tx/0.1y 0*2:3vi.3w0/0.n 0*2:3vi.3wo/d.-2y 0*2:3vv.3tw/0.1',
    '0*2:3vv.3w0/0.n 0*2:3vv.3wo/5.-2y 0*2:3w0.3tw/0.1 0*2:3w0.3w0/0.n 0*2:3w0.3wo/1.-2y',
    '0*2:3w1.3tw/0.1 0*2:3w1.3w0/0.n 0*2:3w1.3wo/6.-2y 0*2:3w7.3w0/0.n 0*2:3w7.3wo/h.-2y',
    '0*2:3wo.3tw/0.1 0*2:3wo.3w0/0.n 0:3wo.3wo 0*2:3u2/b 0:3wn 0*6: 0*2:3tb.3ud/0.1 0*2:3tb.3w0/0.1',
    '0*2:3tb.3wn/0.1 0*2:3te.3ud/0.1 0*2:3te.3w0/0.1 0*2:3te.3wn/0.1 0*2:3tj.3ud/0.1 0*2:3tj.3w0/0.1',
    '0*2:3tj.3wn/0.1 0*2:3tk.3ud/0.1 0*2:3tk.3w0/0.1 0*2:3tk.3wn/0.1 0*2:3v7.3wn/0.1 0*2:3vf.3wn/0.1',
    '0*2:3vi.3tc/0.2j 0*2:3vi.3w0/0.n 0*2:3vi.3wo/d.-o 0*2:3vv.3wn/0.1 0*2:3w0.3tc/0.2o',
    '0*2:3w1.3ud/0.1 0*2:3w1.3w0/0.1 0*2:3w1.3wn/0.1 0:3wn 0*2:3wo.3ud/0.1 0*2:3wo.3w0/0.1',
    '0*2:3wo.3wn/0.1 0*2:3tb.3tq/0.6 0*2:3tb.3tx/0.23 0*2:3tb.3w7/3.-2h 0*2:3te.3tw/0.1',
    '0*2:3te.3w0/0.7 0*2:3tj.3tq/0.6 0*2:3tj.3tx/0.23 0*2:3tj.3w7/1.-7 0*2:3tq.3tw/0.24',
    '0*2:3tw.3tq/0.2a 0*2:3tx.3tq/0.2a 0*2:3up.3tq/0.6 0*2:3up.3tx/0.23 0*2:3uv.3tw/0.1',
    '0*2:3uv.3w0/1.-2a 0*2:3uw.3tw/0.1 0*2:3uw.3w0/4.-24 0*2:3v1.3w0/2.-2a 0*2:3v3.3w0/1.-2a',
    '0*2:3v4.3w0/3.-2a 0*2:3v7.3tw/0.1 0*2:3v7.3w0/8.-24 0*2:3vf.3w0/3.-2a 0*2:3vi.3tw/0.1',
    '0*2:3vi.3vv/0.5 0*2:3vv.3tq/0.6 0*2:3vv.3tx/0.23 0*2:3vv.3w7/5.-2h 0*2:3w0.3tw/0.1',
    '0*2:3w0.3w0/1.-2a 0*2:3w1.3tw/0.1 0*2:3w1.3w0/0.7 0*2:3w7.3tq/0.2a 0:3w7 0*2:3wo.3tq/0.6',
    '0*2:3wo.3tx/0.23 0*2:3wo.3w7/-3d.-7 0*2:3tb.3w7/3.-7 0*2:3te.3w7/5.-7 0*2:3tj.3w7/1.-7',
    '0*2:3tk.3w7/15.-7 0*2:3up.3w7/1.-7 0*2:3uq.3w7/s.-c 0*2:3vi.3w0/d.0 0*2:3w1.3w0/0.7',
    '0*2:3wo.3w0/0.7 0*3: 0*2:3v0.3wn/0.1 0*2:3v3.3wn/0.1 0*2:3v4.3wn/0.1 0*2:3up.3wn/0.1',
    '0*2:3uq.3wn/0.1 0*2:3tw.3wn/0.1 0*2:3tq.3wn/0.1 0*2:3tx.3wn/0.1 0*2:3uv.3wn/0.1 0*2:3uw.3wn/0.1',
    '0*2:3uq.3tq/0.6 0*2:3uq.3tx/0.23 0*2:3uq.3ud/-1.0 0*2:3uv.3ud/1.0 0*2:3v0.3wn/0.1',
    '0*2:3v3.3wn/0.1 0*2:3v4.3wn/0.1 0*2:3up.3wn/0.1 0*2:3uq.3wn/0.1 0*2:3tw.3wn/0.1 0*2:3tq.3wn/0.1',
    '0*2:3tx.3wn/0.1 0*2:3uv.3wn/0.1 0*2:3uw.3wn/0.1 0*2:3uq.3tq/0.6 0*2:3uq.3tx/0.23',
    '0*2:3uq.3ud/-1.0 0*2:3uv.3ud/1.0 0*2:3uq.3tq/0.6 0*2:3uq.3tx/0.23 0*2:3up.3w7/1.0',
    '0*2:3v0.3w0/-b.-2a 0*2:3up.3tw/0.1 0*2:3uq.3tq/0.6 0*2:3uq.3tx/a.23 0:3v1.3w0 0*2:3tc 0*2:jk/1',
    '0*g:1dq9.1e0w/0.1 0*2:3tj.3tq.3w0/0.6.-2a 0*2:3tj.3tw.3tq/0.0.2a 0*2:3tj.3tx.3w0/0.23.-2a',
    '0*2:3tj.3w0.3tw/0.0.1 0*2:3tq.3w0.3tw 0*2:3tw.3w0.3wo/0.0.-1 0*2:3up.3tw.3tq/0.-6.6',
    '0*2:3up.3tq.3wn/0.2a.-2r 0*2:3up.3w0.3tw/0.0.-6 0*2:3up.3w0.3w0 0*2:3uv.3tw.3tw',
    '0*2:3uv.3w0.3w0/-5.-24.0 0*2:3uq.3tw.3w0/0.-6.o 0*2:3uq.3w0.3tx 0*2:3uq.3w0.3w0',
    '0*2:3uw.3tw.3wn/0.1.-n 0*2:3uw.3tx.3w0/4.23.-24 0*2:3v0.3w0.3tw/0.0.24 0*2:3v0.3w0.3wo/3.-2a.-o',
    '0*2:3v3.3w0.3w0 0*2:3v3.3w0.3wn/1.0.-n 0*2:3v4.3w0.3wo/0.0.-1 0*2:3v7.3tx.3w0',
    '0*2:3vf.3w0.3tw/0.0.24 0*2:3vv.3tw.3w0/0.0.o 0*2:3vv.3tw.3wn/0.-6.-2x 0*2:3vv.3tq.3tq/0.7.2a',
    '0*2:3vv.3tx.3w0/0.23.-24 0*2:3vv.3w0.3tw/5.-24.-6 0*2:3w0.3tw.3w0/0.0.o 0*2:3w0.3tq.3tw/0.0.24',
    '0*2:3w0.3tx.3tq/0.0.2a 0*2:1dq9.1e34/0.1 0*2:3w0.3tq.3tx/7.2a.-7 0*2:3w7.3w0.3w0/-6.-24.0',
    '0*2:3w1.3tw.3wn/0.-6.-n 0*2:3w1.3tq.3w0/0.0.n 0*2:3w1.3w0.3wo/0.0.-1 0*2:3wo.3w0.3w0',
    '0*2:3te.3tx.3wo/5.-7.0 0*2:3tj.3tq.3wn/0.7.1 0*2:3tj.3tx.3wn/0.23.1 0*2:3tj.3w0.3wn/7.0.1',
    '0*2:3tq.3tw.3wn/0.24.0 0*2:3up.3tx.3wn/6.-1.1 0*2:3uq.3tw.3wo/6.0.0 0*2:3vv.3tq.3wo/0.2a.0',
    '0*2:3wo.3tw.3wo/0.-6.0 0*2:3wo.3w0.3wo/-o.0.0 0*2:3vf.3w0.3wo/m.-24.0 0*2:3vf.3w0.3tw/g.-24.24',
    '0*2:3v3.3w0.3wo/f.0.0 0*2:3w1.3tq.3tw/-1.7.2s 0*2:3vv.3tq.3w0/-d.2a.0 0*2:3vv.3tq.3w0/6.0.-24',
    '0*2:3tq.3tw.3wo/6.-6.0 0*2:3w0.3tq.3wo/-t.2a.0 0*2:3te.3tw.3wo/24.24.-o 0*2:3v3.3tq.3w0/-8.2a.0',
    '0*2:3up.3tx.3wo/1c.-7.0 0*14:1dq9.1e4o/0.1 0*2:3uv.3vv.3wu/k.0.0',
    '0*2:3tc.3vv.3vv.3w7/0.-d.-2h.-1u 0*2:3w0.3tw.3w0.3u1/-15.1z.-x.1z 0*2:3ud.3up.3wd.3vv/q.16.b.c',
    '0:3wd.3up.3vv.3w0 0:3uv.3vv.3wn 0:1dq9.1e62 0:3tq.3vv.eh.3tq.3vv.3tc.3vv.3w7 0:3ud.3wp.3tc.3vv',
    '0:nj 0*2:1dq9.1e66/0.1 0*g: 0*g:1dq9.1e6o/0.1 0*4: 0*c:1dq9.1e78/0.1 0:gt.gt 0*2:fc/-1 0*2:ez',
    '0*2:i0/1 0*2:i4/1 0*2:jc/1 0*2:ja/1 0*2:j4/1 0*2:j2/1 0*4:j6/1 0*2:fs/1 0*2:i2/1 0*4:ep 0*3:ez',
    '0*2:fj/8 0:gt 0:1dq9.1e8j 0*2:fu/3 0*2:gl/-4 0*2:fc/2o 0*2:i1/3 0*2:i5/17 0*2:jd/p 0*2:jz/-7',
    '0*2:tk/-ef 0*2:to/2 0:tp 0:1dq9.1e93 0*2:jy/281 0*2:k3/-c 0*4:1dq9.1e98/0.1 0*5: 0:1dq9.1e9h',
    '0*a: 0*2:3t3/1 0*2:3t4/1 0*2:3t5/3 0*2:3t8/1 0*2:3t9/2 0*3:3tb 0*2:3tc 0*4:3te 0*2:3ti 0*4:3tj',
    '0*4:3tk 0*4:3tq 0*4:3tw 0*4:3tx 0*2:3u1 0*2:3u2 0*2:3ud 0*2:3ue 0*4:3up 0*4:3uq 0*4:3uv 0*4:3uw',
    '0*4:3v0 0*4:3v1 0*4:3v3 0*4:3v4 0*4:3v7 0*4:3vf 0*4:3vi 0*4:3vv 0*4:3w0 0*4:3w1 0*4:3w7 0*2:3wd',
    '0*2:3wn 0*4:3wo 0*2:3vv.3t4 0*2:3vv.3t5 0*2:3vv.3t9 0*2:3vv.3tc 0*2:1dq9.1ed9/0.1 0: 0:1dq9.1edc',
    '0*2:gh/19 0*2:k2/27x 0*2:k3/-4 0*2:hj/h 0*2:i1/1r 0*2:tk/-e1 0*2:f5/1o 0*2:jw/28t 0*9:2sq/1',
    '0*2:fx/-3 0*3:to/1 0*2:gl/36 0*2:2sz/n 0*2:2u8/d 0*2:2vf/1a 0*2:2wx/w 0*2:2yj/l 0*2:2zl/d',
    '0*2:317/9 0*2:32a/11 0*2:33o/c 0*2:356/o 0*2:36n/11 0*2:381/9 0*2:38e/c 0*2:i2/1w 0*2:i3/-3g',
    '0*2:ez/-f 0*2:2sz/n 0*2:2u8/d 0*2:2vf/1a 0*2:2wx/w 0*2:2yj/l 0*2:2zl/d 0*2:317/9 0*2:32a/11',
    '0*2:33o/c 0*2:356/o 0*2:36n/11 0*2:381/9 0*2:38e/c 0*2:i4/bo 0*2:i5/bq 0*2:ii/1 0*2:h2/24',
    '0*2:j7/-3g 0*2:fi/5le 0*5:5zm/1 0*3:60l/1 0*2:603/-388 0*18:5zm/1 0:60x 0*2: 0*2:5vh/-2j',
    '0*2:5sz/4f 0*2:5t0/4g 0*2:5xh/-4g 0*2:5t2/1 0*6:5xk/1 0*2:5to/-k 0*2:5t5/1 0*2:5tv/-o 0*9:5t8/1',
    '0*3:1dq9.1ein/0.1 0*6:5vi/1 0*2:1dq9.1eiw/0.1 0*6:5vo/1 0*2:1dq9.1ej4/0.1 0*6:5vu/1',
    '0*2:1dq9.1ejc/0.1 0*3:5w0/1 0*3:1dq9.1ejh/0.1 0*2:2ry/2 0*2:tr/-f3 0*2:tt/1y8 0:2sg 0:1dq9.1ejr',
    '0*2:16m/-gg 0*2:q8/-1 0*2:q9/kr 0:1c7 0*a:1dq9.1ejz/0.1 0*3: 0*2:2px/1 0*2:1dq9.1eke/0.1',
].join(' ');

let unicodeCiTable = null;

// at[c] to at[c + 1] is where code point c's weights sit in w.
function unicodeCiWeights() {
    if (unicodeCiTable) return unicodeCiTable;
    const lists = new Array(65536);
    let end = 0;
    for (const e of UNICODE_CI_RUNS.split(' ')) {
        const m = /^(-?[0-9a-z]+)(?:\*([0-9a-z]+))?:([0-9a-z.]*)(?:\/([-0-9a-z.]+))?$/.exec(e);
        const start = end + parseInt(m[1], 36);
        const n = m[2] ? parseInt(m[2], 36) : 1;
        const first = m[3] ? m[3].split('.').map((x) => parseInt(x, 36)) : [];
        const step = m[4] ? m[4].split('.').map((x) => parseInt(x, 36)) : first.map(() => 0);
        for (let k = 0; k < n; k++) {
            lists[start + k] = first.map((x, p) => x + step[p] * k);
        }
        end = start + n;
    }
    const at = new Uint32Array(65537);
    const flat = [];
    for (let c = 0; c < 65536; c++) {
        at[c] = flat.length;
        // A lone surrogate weighs as a character outside the BMP does.
        const list = c >= 0xd800 && c <= 0xdfff ? [0xfffd] : lists[c] || [c];
        for (const x of list) flat.push(x);
    }
    at[65536] = flat.length;
    unicodeCiTable = { at, w: Uint16Array.from(flat) };
    return unicodeCiTable;
}

const UCA_SPACE = 0x209;

/**
 * The utf8mb4_unicode_ci sort key of v: its weights, each as one code point
 * (a weight from D800 up moves up by 0x800, past the surrogates), so two keys
 * compare byte for byte as MariaDB compares the strings. Trailing weights of
 * a space are dropped, as PAD SPACE compares; 'a\t' against 'a' differs from
 * MariaDB as generalCiKey's does. Anything but a string is returned as it is.
 * @param {*} v
 * @returns {*}
 */
function unicodeCiKey(v) {
    if (typeof v !== 'string') return v;
    const { at, w } = unicodeCiWeights();
    const out = [];
    for (let i = 0; i < v.length; i++) {
        const c = v.charCodeAt(i);
        if (c >= 0xd800 && c <= 0xdbff) {
            const d = v.charCodeAt(i + 1);
            if (d >= 0xdc00 && d <= 0xdfff) {
                i++;
                out.push(0xfffd);
                continue;
            }
        }
        for (let k = at[c], e = at[c + 1]; k < e; k++) out.push(w[k]);
    }
    let n = out.length;
    while (n > 0 && out[n - 1] === UCA_SPACE) n--;
    for (let i = 0; i < n; i++) if (out[i] >= 0xd800) out[i] += 0x800;
    let key = '';
    for (let i = 0; i < n; i += 4096) key += String.fromCodePoint.apply(null, out.slice(i, Math.min(n, i + 4096)));
    return key;
}

module.exports = { generalCiKey, unicodeCiKey };
