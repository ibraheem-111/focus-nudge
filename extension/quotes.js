// Ships with the extension so the pause screen works before the daemon is up
// and before any personal quotes are written. Additions go in
// ~/.config/focus-nudge/quotes.txt, which the daemon serves at GET /quotes.

export const BUNDLED_QUOTES = [
  { text: 'You have power over your mind — not outside events. Realize this, and you will find strength.', author: 'Marcus Aurelius' },
  { text: 'The impediment to action advances action. What stands in the way becomes the way.', author: 'Marcus Aurelius' },
  { text: 'You could leave life right now. Let that determine what you do and say and think.', author: 'Marcus Aurelius' },
  { text: 'Confine yourself to the present.', author: 'Marcus Aurelius' },
  { text: 'It is not that we have a short time to live, but that we waste a lot of it.', author: 'Seneca' },
  { text: 'While we are postponing, life speeds by.', author: 'Seneca' },
  { text: 'Begin at once to live, and count each separate day as a separate life.', author: 'Seneca' },
  { text: 'No person has the power to have everything they want, but it is in their power not to want what they don\'t have.', author: 'Seneca' },
  { text: 'First say to yourself what you would be; then do what you have to do.', author: 'Epictetus' },
  { text: 'No man is free who is not master of himself.', author: 'Epictetus' },
  { text: 'If you want to improve, be content to be thought foolish and stupid.', author: 'Epictetus' },
  { text: 'How long are you going to wait before you demand the best for yourself?', author: 'Epictetus' },
  { text: 'Discipline equals freedom.', author: 'Jocko Willink' },
  { text: 'Motivation is unreliable. Discipline is a decision you already made.', author: 'Jocko Willink' },
  { text: 'Discipline is choosing between what you want now and what you want most.', author: 'Abraham Lincoln' },
  { text: 'We are what we repeatedly do. Excellence, then, is not an act but a habit.', author: 'Aristotle' },
  { text: 'The successful warrior is the average man, with laser-like focus.', author: 'Bruce Lee' },
  { text: 'I fear not the man who has practiced ten thousand kicks once, but the man who has practiced one kick ten thousand times.', author: 'Bruce Lee' },
  { text: 'It is not enough to be busy. The question is: what are we busy about?', author: 'Henry David Thoreau' },
  { text: 'The cost of a thing is the amount of life which must be exchanged for it.', author: 'Henry David Thoreau' },
  { text: 'You do not rise to the level of your goals. You fall to the level of your systems.', author: 'James Clear' },
  { text: 'Every action you take is a vote for the person you wish to become.', author: 'James Clear' },
  { text: 'Amateurs sit and wait for inspiration. The rest of us just get up and go to work.', author: 'Stephen King' },
  { text: 'Inspiration is for amateurs. The rest of us show up and get to work.', author: 'Chuck Close' },
  { text: 'The work is the only thing that matters. The rest is noise.', author: 'Unknown' },
  { text: 'Deep work is the ability to focus without distraction on a cognitively demanding task.', author: 'Cal Newport' },
  { text: 'Clarity about what matters provides clarity about what does not.', author: 'Cal Newport' },
  { text: 'A wandering mind is an unhappy mind.', author: 'Killingsworth and Gilbert' },
  { text: 'Concentration is the root of all the higher abilities in man.', author: 'Bruce Lee' },
  { text: 'You will never always be motivated. You must learn to be disciplined.', author: 'Unknown' },
  { text: 'The successful person has the habit of doing the things failures do not like to do.', author: 'E. M. Gray' },
  { text: 'Do the hard jobs first. The easy jobs will take care of themselves.', author: 'Dale Carnegie' },
  { text: 'There is nothing so useless as doing efficiently that which should not be done at all.', author: 'Peter Drucker' },
  { text: 'Absorb what is useful, discard what is useless, add what is specifically your own.', author: 'Bruce Lee' },
  { text: 'Simplicity is the ultimate sophistication.', author: 'Leonardo da Vinci' },
  { text: 'What gets measured gets managed.', author: 'Peter Drucker' },
  { text: 'The man who moves a mountain begins by carrying away small stones.', author: 'Confucius' },
  { text: 'It does not matter how slowly you go so long as you do not stop.', author: 'Confucius' },
  { text: 'Persistence is the twin sister of excellence.', author: 'Marabel Morgan' },
  { text: 'Hard choices, easy life. Easy choices, hard life.', author: 'Jerzy Gregorek' },
  { text: 'Suffer the pain of discipline or suffer the pain of regret.', author: 'Unknown' },
  { text: 'You are always one decision away from a totally different life.', author: 'Unknown' },
  { text: 'The tragedy is not that we die, but that we are so easily distracted from living.', author: 'Unknown' },
  { text: 'Attention is the rarest and purest form of generosity.', author: 'Simone Weil' },
  { text: 'Where your attention goes, your life goes.', author: 'Unknown' },
]

export function pickQuote(bundled, user, randomFn = Math.random) {
  const pool = [...(bundled ?? []), ...(Array.isArray(user) ? user : [])]
  if (pool.length === 0) return { text: 'Back to work.', author: '' }
  const index = Math.min(pool.length - 1, Math.floor(randomFn() * pool.length))
  return pool[index]
}
