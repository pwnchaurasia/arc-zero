//! LogoQuest curriculum (decision 2026-11-17): 100 hand-designed levels for a 9-year-old
//! in Class 3, each adding one small idea. Every level is a pair: Learn (the target is
//! drawn faintly on the board, no clock) and Test (a new shape using the same idea, from
//! a reference card only, with a clock). Passing a Test opens the next Learn.
//!
//! | Levels | Chapter        | New chips                          |
//! |--------|----------------|------------------------------------|
//! | 1-20   | Grid Walker    | FD, BK, RT 90, LT 90               |
//! | 21-40  | Pen & Paint    | PU, PD, COLOR                      |
//! | 41-60  | Angle Explorer | any angle (45, 60, 120, 72, ...)   |
//! | 61-80  | Loop Master    | REPEAT                             |
//! | 81-100 | Spirograph Lab | REPEAT inside REPEAT               |
//!
//! The sample solutions here are the answer key: they stay in the server-only levels
//! file. The browser only gets the drawing to match and the reference card's facts.

use std::collections::BTreeSet;

use arc_engine::logo::{self, Block, Program};
use serde::Serialize;

pub const CHAPTERS: [&str; 5] = [
    "Grid Walker",
    "Pen & Paint",
    "Angle Explorer",
    "Loop Master",
    "Spirograph Lab",
];

/// (title, tip, learn program, test title, test program).
type Entry = (
    &'static str,
    &'static str,
    &'static str,
    &'static str,
    &'static str,
);

#[rustfmt::skip]
const LEVELS: [Entry; 100] = [
    // ---------------------------------------------------------------- 1. Grid Walker
    ("First steps", "FD moves the turtle forward. Tap FD, pick 100, then press Run!", "FD 100", "Short walk", "FD 75"),
    ("Walk back", "BK walks the turtle backwards, without turning around.", "BK 75", "Back again", "BK 100"),
    ("Long line", "Need a long line? Use a big number, or add two: FD 100 then FD 25 is 125.", "FD 125", "Long line sideways", "RT 90 FD 140"),
    ("Turn right", "RT 90 turns the turtle to its right, like the corner of a book. Then FD!", "RT 90 FD 100", "Right walk", "RT 90 FD 75"),
    ("Turn left", "LT 90 turns the turtle to its left.", "LT 90 FD 100", "Left walk", "LT 90 FD 125"),
    ("Letter L", "Walk, turn, walk: you made a corner!", "FD 100 RT 90 FD 50", "Big L", "FD 75 RT 90 FD 75"),
    ("Other corner", "Turning left makes the corner face the other way.", "FD 100 LT 90 FD 75", "Left corner", "FD 50 LT 90 FD 100"),
    ("Step down", "Two right turns make the turtle face down.", "RT 90 FD 50 RT 90 FD 50", "Down the other side", "LT 90 FD 75 LT 90 FD 50"),
    ("Letter U", "Three lines and two turns make a cup.", "FD 100 RT 90 FD 75 RT 90 FD 100", "Upside-down cup", "FD 75 LT 90 FD 100 LT 90 FD 75"),
    ("Square!", "A square has 4 equal sides and 4 turns of 90.", "FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 FD 100", "Left square", "FD 75 LT 90 FD 75 LT 90 FD 75 LT 90 FD 75"),
    ("Rectangle", "A rectangle has two long sides and two short sides.", "FD 50 RT 90 FD 125 RT 90 FD 50 RT 90 FD 125", "Tall rectangle", "FD 125 RT 90 FD 75 RT 90 FD 125 RT 90 FD 75"),
    ("Stairs", "Right, left, right, left: the turtle climbs stairs.", "FD 25 RT 90 FD 25 LT 90 FD 25 RT 90 FD 25 LT 90 FD 25 RT 90 FD 25", "Taller stairs", "FD 25 RT 90 FD 25 LT 90 FD 25 RT 90 FD 25 LT 90 FD 25 RT 90 FD 25 LT 90 FD 25 RT 90 FD 25"),
    ("There and back", "BK walks back over the same line. FD 50 BK 100 makes a line through the start.", "FD 50 BK 100", "Sideways line", "RT 90 FD 75 BK 150"),
    ("Plus sign", "Up and back, then turn, then sideways and back.", "FD 50 BK 100 FD 50 RT 90 FD 50 BK 100", "Big plus", "FD 75 BK 150 FD 75 RT 90 FD 75 BK 150"),
    ("Letter T", "Walk up, turn, then use BK to draw both sides of the top.", "FD 100 LT 90 FD 50 BK 100", "Tall T", "FD 125 RT 90 FD 75 BK 150"),
    ("Domino", "A rectangle with a line across the middle: two squares stuck together.", "FD 100 RT 90 FD 50 RT 90 FD 100 RT 90 FD 50 RT 90 FD 50 RT 90 FD 50", "Lying domino", "RT 90 FD 100 LT 90 FD 50 LT 90 FD 100 LT 90 FD 50 LT 90 FD 50 LT 90 FD 50"),
    ("Letter E", "Use BK to come back after each arm of the E.", "RT 90 FD 50 BK 50 LT 90 FD 50 RT 90 FD 40 BK 40 LT 90 FD 50 RT 90 FD 50", "Letter F", "FD 50 RT 90 FD 40 BK 40 LT 90 FD 50 RT 90 FD 60"),
    ("Window", "A square, then a cross inside it.", "FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 FD 50 RT 90 FD 100 BK 50 LT 90 FD 50 BK 100", "Small window", "FD 80 RT 90 FD 80 RT 90 FD 80 RT 90 FD 80 RT 90 FD 40 RT 90 FD 80 BK 40 LT 90 FD 40 BK 80"),
    ("Snail", "Each line is a bit longer than the last one. Round and round!", "FD 20 RT 90 FD 40 RT 90 FD 60 RT 90 FD 80 RT 90 FD 100 RT 90 FD 120", "Left snail", "FD 25 LT 90 FD 50 LT 90 FD 75 LT 90 FD 100 LT 90 FD 125"),
    ("Castle", "Up, along the top with bumps, and down again. You know all the moves!", "FD 100 RT 90 FD 25 RT 90 FD 25 LT 90 FD 25 LT 90 FD 25 RT 90 FD 25 RT 90 FD 25 LT 90 FD 25 LT 90 FD 25 RT 90 RT 90 FD 100 RT 90 FD 100", "Chimney house", "FD 75 RT 90 FD 25 LT 90 FD 25 RT 90 FD 25 RT 90 FD 25 LT 90 FD 50 RT 90 FD 75 RT 90 FD 100"),
    // ---------------------------------------------------------------- 2. Pen & Paint
    ("Jump!", "PU lifts the pen, so the turtle moves without drawing. PD puts it down again.", "FD 50 PU FD 25 PD FD 50", "Two jumps", "FD 25 PU FD 25 PD FD 25 PU FD 25 PD FD 25"),
    ("Dotted road", "Draw, jump, draw, jump... a road with gaps.", "FD 20 PU FD 20 PD FD 20 PU FD 20 PD FD 20 PU FD 20 PD FD 20", "Sideways road", "RT 90 FD 30 PU FD 15 PD FD 30 PU FD 15 PD FD 30"),
    ("Train tracks", "Draw one line, jump across with the pen up, draw the other.", "FD 100 PU RT 90 FD 50 RT 90 PD FD 100", "Flat tracks", "RT 90 FD 125 PU LT 90 FD 40 LT 90 PD FD 125"),
    ("Colours", "COLOR changes the pen. Try COLOR RED, then draw!", "COLOR RED FD 100", "Blue line", "COLOR BLUE RT 90 FD 100"),
    ("Two colours", "Change colour in the middle of a drawing.", "COLOR YELLOW FD 75 COLOR RED RT 90 FD 75", "Purple and blue", "COLOR PURPLE FD 50 COLOR BLUE LT 90 FD 100"),
    ("Rainbow stairs", "A new colour for every step!", "COLOR RED FD 25 RT 90 FD 25 LT 90 COLOR YELLOW FD 25 RT 90 FD 25 LT 90 COLOR GREEN FD 25 RT 90 FD 25 LT 90 COLOR BLUE FD 25 RT 90 FD 25", "Big rainbow stairs", "COLOR RED FD 40 RT 90 FD 40 LT 90 COLOR YELLOW FD 40 RT 90 FD 40 LT 90 COLOR BLUE FD 40 RT 90 FD 40"),
    ("Two boxes", "Draw a box, lift the pen, walk away, then draw another box.", "FD 50 RT 90 FD 50 RT 90 FD 50 RT 90 FD 50 PU FD 75 PD FD 50 RT 90 FD 50 RT 90 FD 50 RT 90 FD 50", "Red box, blue box", "COLOR BLUE FD 40 RT 90 FD 40 RT 90 FD 40 RT 90 FD 40 PU FD 60 PD COLOR RED FD 40 RT 90 FD 40 RT 90 FD 40 RT 90 FD 40"),
    ("Box in a box", "Draw the big box, jump inside with the pen up, then draw the small one.", "FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 PU FD 25 RT 90 FD 25 LT 90 PD FD 50 RT 90 FD 50 RT 90 FD 50 RT 90 FD 50", "Colour boxes", "COLOR RED FD 120 RT 90 FD 120 RT 90 FD 120 RT 90 FD 120 RT 90 PU FD 30 RT 90 FD 30 LT 90 PD COLOR BLUE FD 60 RT 90 FD 60 RT 90 FD 60 RT 90 FD 60"),
    ("Front door", "A house front with a door: jump to where the door starts.", "FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 RT 90 PU FD 35 LT 90 PD FD 50 RT 90 FD 30 RT 90 FD 50", "Wall with a window", "FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 PU FD 50 RT 90 FD 30 LT 90 PD COLOR BLUE FD 30 RT 90 FD 40 RT 90 FD 30 RT 90 FD 40"),
    ("Equals", "Two lines, one above the other.", "RT 90 FD 100 PU LT 90 FD 30 LT 90 PD FD 100", "Three lines", "RT 90 FD 90 PU LT 90 FD 30 LT 90 PD FD 90 PU RT 90 FD 30 RT 90 PD FD 90"),
    ("Letter H", "No jumps needed: BK takes you back down the middle.", "FD 100 BK 50 RT 90 FD 50 LT 90 FD 50 BK 100", "Letter I", "RT 90 FD 50 BK 25 LT 90 FD 100 LT 90 FD 25 BK 50"),
    ("Say HI", "An H, a jump, then an I.", "FD 100 BK 50 RT 90 FD 50 LT 90 FD 50 BK 100 PU RT 90 FD 25 LT 90 PD FD 100", "Write LI", "FD 100 BK 100 RT 90 FD 50 PU FD 25 LT 90 PD FD 100"),
    ("Ladder", "Climb up, drawing a rung at every step. Then jump over and draw the other rail.", "FD 25 RT 90 FD 50 BK 50 LT 90 FD 25 RT 90 FD 50 BK 50 LT 90 FD 25 RT 90 FD 50 BK 50 LT 90 FD 25 PU RT 90 FD 50 LT 90 PD BK 100", "Yellow ladder", "COLOR YELLOW FD 30 RT 90 FD 40 BK 40 LT 90 FD 30 RT 90 FD 40 BK 40 LT 90 FD 30 PU RT 90 FD 40 LT 90 PD BK 90"),
    ("Traffic light", "A white box with three coloured lights inside, one above the other.", "COLOR WHITE FD 115 RT 90 FD 45 RT 90 FD 115 RT 90 FD 45 RT 90 PU RT 90 FD 10 LT 90 FD 10 PD COLOR GREEN FD 25 RT 90 FD 25 RT 90 FD 25 RT 90 FD 25 RT 90 PU FD 35 PD COLOR YELLOW FD 25 RT 90 FD 25 RT 90 FD 25 RT 90 FD 25 RT 90 PU FD 35 PD COLOR RED FD 25 RT 90 FD 25 RT 90 FD 25 RT 90 FD 25", "Two-light sign", "COLOR WHITE FD 80 RT 90 FD 45 RT 90 FD 80 RT 90 FD 45 RT 90 PU RT 90 FD 10 LT 90 FD 10 PD COLOR RED FD 25 RT 90 FD 25 RT 90 FD 25 RT 90 FD 25 RT 90 PU FD 35 PD COLOR BLUE FD 25 RT 90 FD 25 RT 90 FD 25 RT 90 FD 25"),
    ("Robot face", "A big square head, two square eyes and a mouth.", "FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 PU FD 60 RT 90 FD 20 LT 90 PD FD 20 RT 90 FD 20 RT 90 FD 20 RT 90 FD 20 RT 90 PU RT 90 FD 40 LT 90 PD FD 20 RT 90 FD 20 RT 90 FD 20 RT 90 FD 20 RT 90 PU BK 35 LT 90 FD 50 RT 90 PD COLOR RED RT 90 FD 60", "Sleepy robot", "FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 FD 100 RT 90 PU FD 70 RT 90 FD 20 PD COLOR BLUE FD 20 PU FD 20 PD FD 20 PU BK 50 RT 90 FD 40 LT 90 PD COLOR RED FD 40"),
    ("Fence", "Posts go up and come back down. Walk along to the next one.", "FD 50 BK 50 RT 90 FD 25 LT 90 FD 50 BK 50 RT 90 FD 25 LT 90 FD 50 BK 50 RT 90 FD 25 LT 90 FD 50 BK 50", "Garden fence", "COLOR YELLOW FD 60 BK 60 RT 90 FD 30 LT 90 FD 60 BK 60 RT 90 FD 30 LT 90 FD 60 BK 60 RT 90 FD 30 LT 90 FD 60 BK 60 RT 90 BK 90"),
    ("Colour plus", "Each arm of the plus in its own colour.", "COLOR RED FD 50 BK 50 RT 90 COLOR YELLOW FD 50 BK 50 RT 90 COLOR BLUE FD 50 BK 50 RT 90 COLOR GREEN FD 50 BK 50", "Colour T", "COLOR PURPLE FD 75 LT 90 COLOR YELLOW FD 50 BK 50 COLOR RED BK 50"),
    ("Noughts and crosses", "Two lines up and two lines across. Jump between them.", "PU RT 90 FD 30 LT 90 PD FD 90 PU RT 90 FD 30 RT 90 PD FD 90 PU RT 90 FD 60 RT 90 FD 30 RT 90 PD FD 90 PU LT 90 FD 30 LT 90 PD FD 90", "Small grid", "PU RT 90 FD 25 LT 90 PD FD 75 PU RT 90 FD 25 RT 90 PD FD 75 PU RT 90 FD 50 RT 90 FD 25 RT 90 PD FD 75 PU LT 90 FD 25 LT 90 PD FD 75"),
    ("City", "Tall and short buildings side by side, in different colours.", "COLOR BLUE FD 100 RT 90 FD 40 RT 90 FD 100 RT 90 RT 90 COLOR YELLOW FD 60 RT 90 FD 40 RT 90 FD 60 RT 90 RT 90 COLOR PURPLE FD 80 RT 90 FD 40 RT 90 FD 80 RT 90 COLOR WHITE FD 120", "Two towers", "COLOR RED FD 120 RT 90 FD 40 RT 90 FD 120 LT 90 COLOR BLUE FD 30 LT 90 FD 80 RT 90 FD 40 RT 90 FD 80 RT 90 FD 110"),
    ("Flag", "A pole, then a striped flag at the top.", "FD 125 RT 90 COLOR RED FD 60 RT 90 FD 15 RT 90 FD 60 LT 90 COLOR WHITE FD 15 LT 90 FD 60 RT 90 COLOR GREEN FD 15 RT 90 FD 60", "Two-stripe flag", "FD 120 RT 90 COLOR BLUE FD 70 RT 90 FD 20 RT 90 FD 70 LT 90 COLOR YELLOW FD 20 LT 90 FD 70 RT 90 FD 40"),
    // ---------------------------------------------------------------- 3. Angle Explorer
    ("Lean right", "RT 45 is half of RT 90. The turtle walks slanted!", "RT 45 FD 100", "Lean left", "LT 45 FD 100"),
    ("Roof", "Slant up, turn 90, slant down: a roof!", "RT 45 FD 70 RT 90 FD 70", "Big roof", "LT 45 FD 85 LT 90 FD 85"),
    ("Diamond", "A square, standing on its corner. Start with RT 45.", "RT 45 FD 70 RT 90 FD 70 RT 90 FD 70 RT 90 FD 70", "Left diamond", "LT 45 FD 85 LT 90 FD 85 LT 90 FD 85 LT 90 FD 85"),
    ("Triangle", "A triangle with equal sides turns 120 at each corner.", "RT 90 FD 100 LT 120 FD 100 LT 120 FD 100", "Tilted triangle", "RT 30 FD 90 RT 120 FD 90 RT 120 FD 90"),
    ("Upside-down triangle", "Same triangle, turning right instead of left.", "RT 90 FD 100 RT 120 FD 100 RT 120 FD 100", "Small triangle", "LT 90 FD 80 LT 120 FD 80 LT 120 FD 80"),
    ("House", "A square with a triangle roof. The roof turns 30, 120 and 30.", "FD 60 RT 30 FD 60 RT 120 FD 60 RT 30 FD 60 RT 90 FD 60", "Bigger house", "FD 75 RT 30 FD 75 RT 120 FD 75 RT 30 FD 75 RT 90 FD 75"),
    ("Zigzag", "Turn one way, then the other. Up, down, up, down.", "RT 45 FD 30 RT 90 FD 30 LT 90 FD 30 RT 90 FD 30 LT 90 FD 30 RT 90 FD 30", "Sharp zigzag", "RT 30 FD 50 RT 120 FD 50 LT 120 FD 50 RT 120 FD 50"),
    ("Arrow", "Draw the line, then the two sides of the arrow head with BK.", "FD 100 LT 45 BK 30 FD 30 RT 90 BK 30", "Right arrow", "RT 90 FD 100 LT 45 BK 30 FD 30 RT 90 BK 30"),
    ("Lightning", "Slant, turn back sharply, slant again: a lightning bolt!", "LT 30 FD 60 RT 120 FD 40 LT 120 FD 60", "Yellow lightning", "COLOR YELLOW RT 30 FD 70 LT 120 FD 45 RT 120 FD 70"),
    ("Hexagon", "6 sides, turn 60 each time. That's a lot of blocks!", "FD 50 RT 60 FD 50 RT 60 FD 50 RT 60 FD 50 RT 60 FD 50 RT 60 FD 50 RT 60", "Left hexagon", "FD 40 LT 60 FD 40 LT 60 FD 40 LT 60 FD 40 LT 60 FD 40 LT 60 FD 40 LT 60"),
    ("Pentagon", "5 sides, and the turns are 72.", "FD 60 RT 72 FD 60 RT 72 FD 60 RT 72 FD 60 RT 72 FD 60 RT 72", "Left pentagon", "FD 70 LT 72 FD 70 LT 72 FD 70 LT 72 FD 70 LT 72 FD 70 LT 72"),
    ("Octagon", "8 sides, turns of 45. Like a stop sign!", "FD 40 RT 45 FD 40 RT 45 FD 40 RT 45 FD 40 RT 45 FD 40 RT 45 FD 40 RT 45 FD 40 RT 45 FD 40 RT 45", "Red stop sign", "COLOR RED FD 35 LT 45 FD 35 LT 45 FD 35 LT 45 FD 35 LT 45 FD 35 LT 45 FD 35 LT 45 FD 35 LT 45 FD 35 LT 45"),
    ("Slanted box", "Two long sides and two short sides, leaning over.", "RT 90 FD 80 LT 60 FD 60 LT 120 FD 80 LT 60 FD 60", "Leaning the other way", "LT 90 FD 80 RT 60 FD 50 RT 120 FD 80 RT 60 FD 50"),
    ("Mountains", "Up and down with 120 turns: a row of peaks.", "RT 30 FD 45 RT 120 FD 45 LT 120 FD 45 RT 120 FD 45 LT 120 FD 45 RT 120 FD 45", "Big mountains", "RT 30 FD 70 RT 120 FD 70 LT 120 FD 70 RT 120 FD 70"),
    ("Kite", "A tall diamond with a red tail. 60 and 120 make the pointy corners.", "COLOR RED BK 40 FD 40 COLOR GREEN RT 30 FD 60 LT 60 FD 60 LT 120 FD 60 LT 60 FD 60", "Wide kite", "COLOR BLUE BK 30 FD 30 COLOR YELLOW RT 60 FD 50 LT 120 FD 50 LT 60 FD 50 LT 120 FD 50"),
    ("Fish", "A diamond body, then a triangle tail at the back.", "RT 45 FD 50 RT 90 FD 50 RT 90 FD 50 RT 90 FD 50 BK 30 LT 45 FD 42 RT 135 FD 30", "Blue fish", "COLOR BLUE LT 45 FD 50 LT 90 FD 50 LT 90 FD 50 LT 90 FD 50 BK 30 RT 45 FD 42 LT 135 FD 30"),
    ("Star of two triangles", "A triangle pointing up. Then turn to face up, jump, and draw one pointing down.", "RT 90 FD 90 LT 120 FD 90 LT 120 FD 90 PU RT 150 FD 52 RT 90 PD FD 90 RT 120 FD 90 RT 120 FD 90", "Coloured star", "COLOR YELLOW RT 90 FD 90 LT 120 FD 90 LT 120 FD 90 PU RT 150 FD 52 RT 90 PD COLOR BLUE FD 90 RT 120 FD 90 RT 120 FD 90"),
    ("Gem", "Flat top, short slanted shoulders, long sides down to a point. All turns are 45 and 90.", "RT 90 FD 40 RT 45 FD 28 RT 90 FD 57 RT 90 FD 57 RT 90 FD 28", "Purple gem", "COLOR PURPLE RT 90 FD 60 RT 45 FD 35 RT 90 FD 78 RT 90 FD 78 RT 90 FD 35"),
    ("Tree", "Two triangles on top of each other, and a trunk.", "RT 90 FD 40 LT 120 FD 80 LT 120 FD 80 LT 120 FD 40 PU LT 90 FD 50 RT 90 PD FD 30 LT 120 FD 60 LT 120 FD 60 LT 120 FD 30 PU RT 90 FD 50 FD 20 PD COLOR YELLOW FD 20", "Snowy tree", "COLOR WHITE RT 90 FD 50 LT 120 FD 100 LT 120 FD 100 LT 120 FD 50 PU RT 90 FD 20 PD COLOR YELLOW FD 20"),
    ("Rocket", "A tall box, a pointy nose with 30 and 120 turns, and fins at 45.", "FD 100 RT 30 FD 40 RT 120 FD 40 RT 30 FD 100 RT 90 FD 40 LT 45 FD 20 BK 20 RT 45 BK 40 LT 135 FD 20", "Red rocket", "COLOR RED FD 90 RT 30 FD 50 RT 120 FD 50 RT 30 FD 90 RT 90 FD 50"),
    // ---------------------------------------------------------------- 4. Loop Master
    ("Magic REPEAT", "REPEAT 4 [ FD 100 RT 90 ] does what's in the brackets 4 times. A square in 3 blocks!", "REPEAT 4 [ FD 100 RT 90 ]", "Left square, short", "REPEAT 4 [ FD 75 LT 90 ]"),
    ("Triangle loop", "3 sides, 120 turns. REPEAT 3!", "REPEAT 3 [ FD 100 RT 120 ]", "Left triangle loop", "REPEAT 3 [ FD 80 LT 120 ]"),
    ("Hexagon loop", "Remember the long hexagon? Now it takes 3 blocks.", "REPEAT 6 [ FD 50 RT 60 ]", "Small hexagon loop", "REPEAT 6 [ FD 40 LT 60 ]"),
    ("Pentagon loop", "5 sides, 72 each turn.", "REPEAT 5 [ FD 60 RT 72 ]", "Left pentagon loop", "REPEAT 5 [ FD 50 LT 72 ]"),
    ("Octagon loop", "8 sides, 45 each turn.", "REPEAT 8 [ FD 40 RT 45 ]", "Left octagon loop", "REPEAT 8 [ FD 35 LT 45 ]"),
    ("Any shape", "The turns always add up to 360. For 9 sides, turn 360 / 9 = 40.", "REPEAT 9 [ FD 30 RT 40 ]", "12 sides, turning left", "REPEAT 12 [ FD 20 LT 30 ]"),
    ("Dashes", "Put PU and PD inside the loop for a dotted line.", "REPEAT 5 [ FD 10 PU FD 10 PD ]", "Long dashes", "REPEAT 6 [ FD 15 PU FD 5 PD ]"),
    ("Stairs loop", "One step is FD, RT, FD, LT. Repeat it!", "REPEAT 4 [ FD 25 RT 90 FD 25 LT 90 ]", "Stairs to the left", "REPEAT 5 [ FD 20 LT 90 FD 20 RT 90 ]"),
    ("Star", "A star is REPEAT 5 with a big turn: 144.", "REPEAT 5 [ FD 100 RT 144 ]", "Left star", "REPEAT 5 [ FD 110 LT 144 ]"),
    ("Saw", "Each tooth goes up and comes down.", "REPEAT 4 [ RT 45 FD 24 RT 90 FD 24 LT 135 ]", "Upside-down saw", "RT 90 REPEAT 4 [ RT 45 FD 21 LT 90 FD 21 RT 45 ]"),
    ("Sun rays", "A line out and back, then turn a little. Again and again.", "REPEAT 8 [ FD 70 BK 70 RT 45 ]", "12 rays", "REPEAT 12 [ FD 60 BK 60 RT 30 ]"),
    ("Fence loop", "One post and a step along, repeated.", "REPEAT 5 [ FD 60 BK 60 RT 90 FD 20 LT 90 ]", "Short fence", "RT 90 REPEAT 6 [ LT 90 FD 40 BK 40 RT 90 FD 20 ]"),
    ("Circle", "36 tiny steps with tiny turns of 10 make a circle!", "REPEAT 36 [ FD 8 RT 10 ]", "Left circle", "REPEAT 36 [ FD 6 LT 10 ]"),
    ("Half circle", "Half a circle is half the steps: 18.", "REPEAT 18 [ FD 8 RT 10 ]", "Quarter circle", "REPEAT 9 [ FD 12 RT 10 ]"),
    ("Pointy star", "8 points with turns of 135.", "REPEAT 8 [ FD 100 RT 135 ]", "9-point star", "REPEAT 9 [ FD 100 RT 160 ]"),
    ("Row of boxes", "Inside the loop: draw a box, then step over for the next one.", "REPEAT 3 [ FD 40 RT 90 FD 40 RT 90 FD 40 RT 90 FD 40 RT 90 RT 90 FD 40 LT 90 ]", "Tower of boxes", "REPEAT 3 [ FD 40 RT 90 FD 40 RT 90 FD 40 RT 90 FD 40 RT 90 FD 40 ]"),
    ("Row of triangles", "Draw a triangle, then step to the next spot.", "RT 90 REPEAT 4 [ LT 60 FD 30 RT 120 FD 30 LT 60 ]", "Upside-down triangles", "RT 90 REPEAT 3 [ RT 60 FD 40 LT 120 FD 40 RT 60 ]"),
    ("Steering wheel", "Spokes from the middle: out, turn, and back.", "REPEAT 6 [ FD 60 RT 120 FD 60 BK 60 LT 120 BK 60 RT 60 ]", "Compass", "REPEAT 4 [ FD 60 LT 45 FD 15 BK 15 RT 90 FD 15 BK 15 LT 45 BK 60 RT 90 ]"),
    ("Comb", "Up, across, down, turn around: one tooth. Repeat it for a comb.", "REPEAT 4 [ FD 60 RT 90 FD 30 RT 90 FD 60 RT 180 ]", "Comb to the left", "REPEAT 4 [ FD 50 LT 90 FD 25 LT 90 FD 50 LT 180 ]"),
    ("Snowflake", "Each arm has a little V near its tip. Make one arm, then REPEAT 6.", "REPEAT 6 [ FD 40 LT 45 FD 20 BK 20 RT 90 FD 20 BK 20 LT 45 FD 20 BK 60 RT 60 ]", "Blue snowflake", "COLOR BLUE REPEAT 8 [ FD 50 LT 45 FD 15 BK 15 RT 90 FD 15 BK 15 LT 45 BK 50 RT 45 ]"),
    // ---------------------------------------------------------------- 5. Spirograph Lab
    ("Four squares", "A REPEAT inside a REPEAT: one square, turn, again!", "REPEAT 4 [ REPEAT 4 [ FD 50 RT 90 ] RT 90 ]", "Four left squares", "REPEAT 4 [ REPEAT 4 [ FD 40 LT 90 ] LT 90 ]"),
    ("Square row", "The inner loop draws a box. The outer loop moves along.", "RT 90 REPEAT 4 [ LT 90 REPEAT 4 [ FD 30 RT 90 ] RT 90 FD 30 ]", "Triangle row", "RT 90 REPEAT 3 [ LT 90 REPEAT 3 [ FD 40 RT 120 ] RT 90 FD 40 ]"),
    ("Spinning squares", "Draw a square, turn a little, draw again.", "REPEAT 6 [ REPEAT 4 [ FD 70 RT 90 ] RT 60 ]", "8 spinning squares", "REPEAT 8 [ REPEAT 4 [ FD 60 RT 90 ] RT 45 ]"),
    ("Triangle flower", "Six triangles around the middle.", "REPEAT 6 [ REPEAT 3 [ FD 70 RT 120 ] RT 60 ]", "Five triangles", "REPEAT 5 [ REPEAT 3 [ FD 70 RT 120 ] RT 72 ]"),
    ("Hexagon ring", "Six hexagons in a ring.", "REPEAT 6 [ REPEAT 6 [ FD 30 RT 60 ] RT 60 ]", "Octagon ring", "REPEAT 8 [ REPEAT 8 [ FD 15 RT 45 ] RT 45 ]"),
    ("Circle flower", "Eight circles, each turned a little.", "REPEAT 8 [ REPEAT 36 [ FD 4 RT 10 ] RT 45 ]", "Six circles", "REPEAT 6 [ REPEAT 36 [ FD 5 RT 10 ] RT 60 ]"),
    ("Star of stars", "A star inside a loop that turns 72.", "REPEAT 5 [ REPEAT 5 [ FD 40 RT 144 ] RT 72 ]", "Six big stars", "REPEAT 6 [ REPEAT 5 [ FD 60 RT 144 ] RT 60 ]"),
    ("Pentagon flower", "Ten pentagons, turning 36 each time.", "REPEAT 10 [ REPEAT 5 [ FD 50 RT 72 ] RT 36 ]", "Twelve pentagons", "REPEAT 12 [ REPEAT 5 [ FD 40 RT 72 ] RT 30 ]"),
    ("Square spiral flower", "Twelve squares, turning 30 each time.", "REPEAT 12 [ REPEAT 4 [ FD 80 RT 90 ] RT 30 ]", "Nine squares", "REPEAT 9 [ REPEAT 4 [ FD 70 RT 90 ] RT 40 ]"),
    ("Petals", "A petal is two curves. Six petals make a flower.", "REPEAT 6 [ REPEAT 2 [ REPEAT 9 [ FD 8 RT 10 ] RT 90 ] RT 60 ]", "Eight petals", "REPEAT 8 [ REPEAT 2 [ REPEAT 9 [ FD 7 RT 10 ] RT 90 ] RT 45 ]"),
    ("Octagon mandala", "Eight octagons around the middle.", "REPEAT 8 [ REPEAT 8 [ FD 25 RT 45 ] RT 45 ]", "Six hexagons", "REPEAT 6 [ REPEAT 6 [ FD 35 RT 60 ] RT 60 ]"),
    ("Rays with stars", "A line out, a tiny star at the end, and back.", "REPEAT 8 [ FD 60 REPEAT 5 [ FD 15 RT 144 ] BK 60 RT 45 ]", "Rays with boxes", "REPEAT 6 [ FD 50 REPEAT 4 [ FD 15 RT 90 ] BK 50 RT 60 ]"),
    ("Two-colour pinwheel", "Change colour inside the loop!", "REPEAT 2 [ COLOR RED REPEAT 4 [ FD 60 RT 90 ] RT 90 COLOR BLUE REPEAT 4 [ FD 60 RT 90 ] RT 90 ]", "Three-colour flower", "REPEAT 2 [ COLOR RED REPEAT 3 [ FD 60 RT 120 ] RT 60 COLOR YELLOW REPEAT 3 [ FD 60 RT 120 ] RT 60 COLOR BLUE REPEAT 3 [ FD 60 RT 120 ] RT 60 ]"),
    ("Snowflake loops", "Each arm has two little Vs. Loops inside loops!", "REPEAT 6 [ REPEAT 2 [ FD 25 LT 45 FD 15 BK 15 RT 90 FD 15 BK 15 LT 45 ] BK 50 RT 60 ]", "Eight-arm snowflake", "COLOR BLUE REPEAT 8 [ REPEAT 2 [ FD 25 LT 45 FD 12 BK 12 RT 90 FD 12 BK 12 LT 45 ] BK 50 RT 45 ]"),
    ("Triangle of triangles", "A small triangle in each corner of a big one.", "REPEAT 3 [ REPEAT 3 [ FD 50 RT 120 ] FD 100 RT 120 ]", "Square of squares", "REPEAT 4 [ REPEAT 4 [ FD 40 RT 90 ] FD 80 RT 90 ]"),
    ("Mandala", "Twelve hexagons, turning 30 each time.", "REPEAT 12 [ REPEAT 6 [ FD 30 RT 60 ] RT 30 ]", "Ten big pentagons", "REPEAT 10 [ REPEAT 5 [ FD 55 RT 72 ] RT 36 ]"),
    ("Rose", "Eighteen circles, turning 20 each time.", "REPEAT 18 [ REPEAT 36 [ FD 4 RT 10 ] RT 20 ]", "Twelve big circles", "REPEAT 12 [ REPEAT 36 [ FD 6 RT 10 ] RT 30 ]"),
    ("Grid of boxes", "Three loops deep: a box, a row of boxes, rows of rows.", "PU BK 45 RT 90 BK 45 LT 90 PD REPEAT 3 [ REPEAT 3 [ REPEAT 4 [ FD 30 RT 90 ] RT 90 FD 30 LT 90 ] PU FD 30 LT 90 FD 90 RT 90 PD ]", "Grid of triangles", "PU BK 45 RT 90 BK 45 LT 90 PD REPEAT 3 [ REPEAT 3 [ REPEAT 3 [ FD 30 RT 120 ] RT 90 FD 30 LT 90 ] PU FD 30 LT 90 FD 90 RT 90 PD ]"),
    ("Colour mandala", "Blue squares behind, yellow triangles in front.", "COLOR BLUE REPEAT 12 [ REPEAT 4 [ FD 70 RT 90 ] RT 30 ] COLOR YELLOW REPEAT 6 [ REPEAT 3 [ FD 50 RT 120 ] RT 60 ]", "Colour rose", "COLOR PURPLE REPEAT 9 [ REPEAT 4 [ FD 60 RT 90 ] RT 40 ] COLOR GREEN REPEAT 8 [ REPEAT 36 [ FD 3 RT 10 ] RT 45 ]"),
    ("Grand finale", "Everything you know: colours, loops in loops, and a circle around it all. You're a programmer!", "COLOR YELLOW REPEAT 10 [ REPEAT 5 [ FD 40 RT 144 ] RT 36 ] COLOR BLUE REPEAT 12 [ REPEAT 6 [ FD 25 RT 60 ] RT 30 ] PU LT 90 FD 46 RT 90 PD COLOR RED REPEAT 36 [ FD 8 RT 10 ]", "Final exam", "COLOR PURPLE REPEAT 8 [ REPEAT 4 [ FD 60 RT 90 ] RT 45 ] COLOR YELLOW REPEAT 6 [ REPEAT 5 [ FD 30 RT 144 ] RT 60 ] PU RT 90 FD 40 LT 90 PD COLOR GREEN REPEAT 36 [ FD 7 LT 10 ]"),
];

#[derive(Clone, Debug, Serialize)]
pub struct Stage {
    pub title: &'static str,
    /// The answer key, as Logo text. Server-only.
    pub program: String,
    /// Blocks in the answer key: fewer or equal earns 3 stars.
    pub par: usize,
}

#[derive(Clone, Debug, Serialize)]
pub struct LogoLevel {
    pub level: u16,
    pub chapter: u8,
    pub chapter_name: &'static str,
    /// What this level teaches, in words a 9-year-old can read.
    pub tip: &'static str,
    pub learn: Stage,
    pub test: Stage,
    /// The Test's reference card: lengths, turns, colours and pen jumps to use.
    pub facts: Vec<String>,
}

fn stage(title: &'static str, text: &str) -> Stage {
    let program = logo::parse(text).unwrap_or_else(|e| panic!("{title}: {e}"));
    assert!(
        !logo::run(&program).segments.is_empty(),
        "{title} draws nothing"
    );
    Stage {
        title,
        program: logo::to_text(&program),
        par: logo::blocks(&program),
    }
}

/// What the reference card tells the player: every length and turn used, colours and
/// how many times the pen is lifted. It never says how to combine them.
fn facts(program: &Program) -> Vec<String> {
    let mut lengths = BTreeSet::new();
    let mut turns = BTreeSet::new();
    let mut colours = Vec::new();
    let mut lifts = 0;
    fn walk(
        p: &[Block],
        lengths: &mut BTreeSet<u16>,
        turns: &mut BTreeSet<u16>,
        colours: &mut Vec<&'static str>,
        lifts: &mut usize,
    ) {
        for b in p {
            match b {
                Block::Fd { n } | Block::Bk { n } => {
                    lengths.insert(*n);
                }
                Block::Rt { n } | Block::Lt { n } => {
                    turns.insert(*n);
                }
                Block::Pu => *lifts += 1,
                Block::Color { c } => {
                    if !colours.contains(&c.name()) {
                        colours.push(c.name());
                    }
                }
                Block::Repeat { body, .. } => walk(body, lengths, turns, colours, lifts),
                Block::Pd => {}
            }
        }
    }
    walk(program, &mut lengths, &mut turns, &mut colours, &mut lifts);
    let list = |s: &BTreeSet<u16>, unit: &str| {
        s.iter()
            .map(|n| format!("{n}{unit}"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut out = vec![format!("Lengths: {}", list(&lengths, ""))];
    if !turns.is_empty() {
        out.push(format!("Turns: {}", list(&turns, "°")));
    }
    if !colours.is_empty() {
        out.push(format!("Colours: {}", colours.join(", ").to_lowercase()));
    }
    if lifts > 0 {
        out.push("The pen goes up to jump".into());
    }
    out
}

pub fn generate(levels: &[u16]) -> Vec<LogoLevel> {
    LEVELS
        .iter()
        .enumerate()
        .filter(|(i, _)| levels.contains(&(*i as u16 + 1)))
        .map(|(i, &(title, tip, learn, test_title, test))| {
            let level = i as u16 + 1;
            let chapter = (i / 20) as u8 + 1;
            let test = stage(test_title, test);
            LogoLevel {
                level,
                chapter,
                chapter_name: CHAPTERS[usize::from(chapter - 1)],
                tip,
                learn: stage(title, learn),
                facts: facts(&logo::parse(&test.program).expect("parsed once")),
                test,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use arc_engine::logo::{depth, judge, run, HALF_BOARD};

    #[test]
    fn every_drawing_fits_the_board_and_uses_its_chapters_chips() {
        for l in generate(&(1..=100).collect::<Vec<u16>>()) {
            for s in [&l.learn, &l.test] {
                let p = logo::parse(&s.program).unwrap();
                let r = run(&p);
                // Keep a margin from the edge so the drawing is never cut off.
                let edge = (HALF_BOARD - 5) * 1_000;
                for seg in &r.segments {
                    for v in [seg.x1, seg.y1, seg.x2, seg.y2] {
                        assert!(
                            v.abs() <= edge,
                            "level {} {}: off the board ({v})",
                            l.level,
                            s.title
                        );
                    }
                }
                let max_depth = match l.chapter {
                    1..=3 => 0,
                    4 => 1,
                    _ => 3,
                };
                assert!(
                    depth(&p) <= max_depth,
                    "level {} {}: REPEAT too early",
                    l.level,
                    s.title
                );
                // The answer key passes its own judge.
                assert!(judge(&r.segments, &r.segments).passed);
            }
            // Learn and Test must be different drawings.
            let a = run(&logo::parse(&l.learn.program).unwrap()).segments;
            let b = run(&logo::parse(&l.test.program).unwrap()).segments;
            assert!(
                !judge(&a, &b).passed,
                "level {}: Test is the same drawing as Learn",
                l.level
            );
        }
    }

    /// Writes every drawing to one SVG contact sheet, for a person to look over:
    /// `LOGO_PREVIEW=/tmp/logo.svg cargo test -p arc-levelgen preview -- --ignored`.
    #[test]
    #[ignore = "writes a file for a person to look at"]
    fn preview() {
        let path = std::env::var("LOGO_PREVIEW").expect("LOGO_PREVIEW");
        let cell = 160;
        let cols = 10;
        let levels = generate(&(1..=100).collect::<Vec<u16>>());
        let rows = (levels.len() * 2).div_ceil(cols);
        let mut svg = format!(
            "<svg xmlns='http://www.w3.org/2000/svg' width='{}' height='{}' style='background:#0b1020'>",
            cols * cell,
            rows * cell
        );
        for (k, (l, s)) in levels
            .iter()
            .flat_map(|l| [(l, &l.learn), (l, &l.test)])
            .enumerate()
        {
            let (cx, cy) = ((k % cols) * cell, (k / cols) * cell);
            svg += &format!(
                "<g transform='translate({},{}) scale(0.48)'><rect x='-150' y='-150' width='300' height='300' fill='#141b33' stroke='#2a3560'/>",
                cx + cell / 2,
                cy + cell / 2 + 8
            );
            for seg in run(&logo::parse(&s.program).unwrap()).segments {
                let c = match seg.color {
                    logo::Color::Green => "#22c55e",
                    logo::Color::Blue => "#38bdf8",
                    logo::Color::Yellow => "#facc15",
                    logo::Color::Red => "#fb7185",
                    logo::Color::Purple => "#a78bfa",
                    logo::Color::White => "#f8fafc",
                };
                svg += &format!(
                    "<line x1='{}' y1='{}' x2='{}' y2='{}' stroke='{c}' stroke-width='3' stroke-linecap='round'/>",
                    seg.x1 as f64 / 1000.0,
                    seg.y1 as f64 / 1000.0,
                    seg.x2 as f64 / 1000.0,
                    seg.y2 as f64 / 1000.0
                );
            }
            svg += "</g>";
            svg += &format!(
                "<text x='{}' y='{}' fill='#8b95b8' font-size='11' font-family='sans-serif'>{} {}: {}</text>",
                cx + 4,
                cy + 12,
                l.level,
                if std::ptr::eq(s, &l.learn) { "L" } else { "T" },
                s.title
            );
        }
        svg += "</svg>";
        std::fs::write(path, svg).unwrap();
    }
}
