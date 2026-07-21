/**
 * Quotes Library - Curated collection of famous quotes by theme
 */

const QuotesLibrary = {
    themes: [
        {
            name: 'Discipline',
            quotes: [
                { text: 'Discipline is the bridge between goals and accomplishment.', author: 'Jim Rohn' },
                { text: 'We do not rise to the level of our goals. We fall to the level of our systems.', author: 'James Clear' },
                { text: 'With self-discipline, almost anything is possible.', author: 'Theodore Roosevelt' },
                { text: 'Discipline is choosing between what you want now and what you want most.', author: 'Abraham Lincoln' },
                { text: 'The only discipline that lasts is self-discipline.', author: 'Bum Phillips' },
                { text: 'Freedom is nothing but a chance to be better.', author: 'Albert Camus' },
                { text: 'Small disciplines repeated with consistency every day lead to great achievements gained slowly over time.', author: 'John C. Maxwell' },
                { text: 'Motivation gets you going, but discipline keeps you growing.', author: 'John C. Maxwell' },
                { text: 'It is not that we have a short time to live, but that we waste a good deal of it.', author: 'Seneca' },
                { text: 'You will never always be motivated. You have to learn to be disciplined.', author: 'Unknown' },
            ]
        },
        {
            name: 'Success',
            quotes: [
                { text: 'Success is not final, failure is not fatal: it is the courage to continue that counts.', author: 'Winston Churchill' },
                { text: 'The only way to do great work is to love what you do.', author: 'Steve Jobs' },
                { text: 'Success usually comes to those who are too busy to be looking for it.', author: 'Henry David Thoreau' },
                { text: 'Don\'t be afraid to give up the good to go for the great.', author: 'John D. Rockefeller' },
                { text: 'I find that the harder I work, the more luck I seem to have.', author: 'Thomas Jefferson' },
                { text: 'The secret of success is to do the common thing uncommonly well.', author: 'John D. Rockefeller Jr.' },
                { text: 'Success is walking from failure to failure with no loss of enthusiasm.', author: 'Winston Churchill' },
                { text: 'The way to get started is to quit talking and begin doing.', author: 'Walt Disney' },
                { text: 'If you really look closely, most overnight successes took a long time.', author: 'Steve Jobs' },
                { text: 'Opportunities don\'t happen. You create them.', author: 'Chris Grosser' },
            ]
        },
        {
            name: 'Perseverance',
            quotes: [
                { text: 'It does not matter how slowly you go as long as you do not stop.', author: 'Confucius' },
                { text: 'Fall seven times, stand up eight.', author: 'Japanese Proverb' },
                { text: 'Our greatest glory is not in never falling, but in rising every time we fall.', author: 'Confucius' },
                { text: 'Perseverance is not a long race; it is many short races one after the other.', author: 'Walter Elliot' },
                { text: 'The man who moves a mountain begins by carrying away small stones.', author: 'Confucius' },
                { text: 'You may have to fight a battle more than once to win it.', author: 'Margaret Thatcher' },
                { text: 'Many of life\'s failures are people who did not realize how close they were to success when they gave up.', author: 'Thomas Edison' },
                { text: 'Courage is not having the strength to go on; it is going on when you don\'t have the strength.', author: 'Theodore Roosevelt' },
                { text: 'A river cuts through rock not because of its power but because of its persistence.', author: 'Jim Watkins' },
                { text: 'It always seems impossible until it\'s done.', author: 'Nelson Mandela' },
            ]
        },
        {
            name: 'Mindset',
            quotes: [
                { text: 'Whether you think you can or you think you can\'t, you\'re right.', author: 'Henry Ford' },
                { text: 'The mind is everything. What you think you become.', author: 'Buddha' },
                { text: 'We become what we think about most of the time.', author: 'Earl Nightingale' },
                { text: 'Your limitation—it\'s only your imagination.', author: 'Unknown' },
                { text: 'Once you replace negative thoughts with positive ones, you\'ll start having positive results.', author: 'Willie Nelson' },
                { text: 'The only person you are destined to become is the person you decide to be.', author: 'Ralph Waldo Emerson' },
                { text: 'What lies behind us and what lies before us are tiny matters compared to what lies within us.', author: 'Ralph Waldo Emerson' },
                { text: 'You are not a drop in the ocean. You are the entire ocean in a drop.', author: 'Rumi' },
                { text: 'Change your thoughts and you change your world.', author: 'Norman Vincent Peale' },
                { text: 'The greatest discovery of all time is that a person can change their future by merely changing their attitude.', author: 'Oprah Winfrey' },
            ]
        },
        {
            name: 'Courage',
            quotes: [
                { text: 'Life shrinks or expands in proportion to one\'s courage.', author: 'Anais Nin' },
                { text: 'You gain strength, courage, and confidence by every experience in which you really stop to look fear in the face.', author: 'Eleanor Roosevelt' },
                { text: 'Courage is resistance to fear, mastery of fear — not absence of fear.', author: 'Mark Twain' },
                { text: 'He who is not courageous enough to take risks will accomplish nothing in life.', author: 'Muhammad Ali' },
                { text: 'It takes courage to grow up and become who you really are.', author: 'E.E. Cummings' },
                { text: 'Do the thing you fear most and the death of fear is certain.', author: 'Mark Twain' },
                { text: 'Fortune favors the bold.', author: 'Virgil' },
                { text: 'Inaction breeds doubt and fear. Action breeds confidence and courage.', author: 'Dale Carnegie' },
                { text: 'Have the courage to follow your heart and intuition. They somehow already know what you truly want to become.', author: 'Steve Jobs' },
                { text: 'Being deeply loved by someone gives you strength, while loving someone deeply gives you courage.', author: 'Lao Tzu' },
            ]
        },
        {
            name: 'Leadership',
            quotes: [
                { text: 'A leader is one who knows the way, goes the way, and shows the way.', author: 'John C. Maxwell' },
                { text: 'The greatest leader is not the one who does the greatest things, but the one who gets people to do the greatest things.', author: 'Ronald Reagan' },
                { text: 'Before you are a leader, success is all about growing yourself. When you become a leader, success is all about growing others.', author: 'Jack Welch' },
                { text: 'Leadership is not about being in charge. It is about taking care of those in your charge.', author: 'Simon Sinek' },
                { text: 'The task of leadership is not to put greatness into people, but to elicit it, for the greatness is there already.', author: 'John Buchan' },
                { text: 'A genuine leader is not a searcher for consensus but a molder of consensus.', author: 'Martin Luther King Jr.' },
                { text: 'Management is doing things right; leadership is doing the right things.', author: 'Peter Drucker' },
                { text: 'Innovation distinguishes between a leader and a follower.', author: 'Steve Jobs' },
                { text: 'If your actions inspire others to dream more, learn more, do more and become more, you are a leader.', author: 'John Quincy Adams' },
                { text: 'The pessimist complains about the wind. The optimist expects it to change. The leader adjusts the sails.', author: 'John C. Maxwell' },
            ]
        },
        {
            name: 'Wisdom',
            quotes: [
                { text: 'The only true wisdom is in knowing you know nothing.', author: 'Socrates' },
                { text: 'In the middle of difficulty lies opportunity.', author: 'Albert Einstein' },
                { text: 'Knowing yourself is the beginning of all wisdom.', author: 'Aristotle' },
                { text: 'The fool doth think he is wise, but the wise man knows himself to be a fool.', author: 'William Shakespeare' },
                { text: 'Turn your wounds into wisdom.', author: 'Oprah Winfrey' },
                { text: 'The measure of intelligence is the ability to change.', author: 'Albert Einstein' },
                { text: 'By three methods we may learn wisdom: first, by reflection, which is noblest; second, by imitation, which is easiest; and third by experience, which is the bitterest.', author: 'Confucius' },
                { text: 'It is the mark of an educated mind to be able to entertain a thought without accepting it.', author: 'Aristotle' },
                { text: 'The unexamined life is not worth living.', author: 'Socrates' },
                { text: 'He who has a why to live can bear almost any how.', author: 'Friedrich Nietzsche' },
            ]
        },
        {
            name: 'Happiness',
            quotes: [
                { text: 'Happiness is not something ready-made. It comes from your own actions.', author: 'Dalai Lama' },
                { text: 'The purpose of our lives is to be happy.', author: 'Dalai Lama' },
                { text: 'For every minute you are angry you lose sixty seconds of happiness.', author: 'Ralph Waldo Emerson' },
                { text: 'Happiness depends upon ourselves.', author: 'Aristotle' },
                { text: 'The most important thing is to enjoy your life — to be happy. It\'s all that matters.', author: 'Audrey Hepburn' },
                { text: 'Happiness is when what you think, what you say, and what you do are in harmony.', author: 'Mahatma Gandhi' },
                { text: 'The only way to find true happiness is to risk being completely cut open.', author: 'Chuck Palahniuk' },
                { text: 'Count your age by friends, not years. Count your life by smiles, not tears.', author: 'John Lennon' },
                { text: 'Very little is needed to make a happy life; it is all within yourself, in your way of thinking.', author: 'Marcus Aurelius' },
                { text: 'Happiness is not a destination, it\'s a journey. Happiness is not tomorrow, it is now.', author: 'Unknown' },
            ]
        },
        {
            name: 'Creativity',
            quotes: [
                { text: 'Creativity is intelligence having fun.', author: 'Albert Einstein' },
                { text: 'The chief enemy of creativity is good sense.', author: 'Pablo Picasso' },
                { text: 'Creativity takes courage.', author: 'Henri Matisse' },
                { text: 'You can\'t use up creativity. The more you use, the more you have.', author: 'Maya Angelou' },
                { text: 'Creativity is seeing what others see and thinking what no one else ever thought.', author: 'Albert Einstein' },
                { text: 'The desire to create is one of the deepest yearnings of the human soul.', author: 'Dieter F. Uchtdorf' },
                { text: 'Every child is an artist. The problem is how to remain an artist once we grow up.', author: 'Pablo Picasso' },
                { text: 'To live a creative life, we must lose our fear of being wrong.', author: 'Joseph Chilton Pearce' },
                { text: 'Imagination is the beginning of creation.', author: 'George Bernard Shaw' },
                { text: 'Don\'t think. Thinking is the enemy of creativity.', author: 'Ray Bradbury' },
            ]
        },
        {
            name: 'Focus',
            quotes: [
                { text: 'Concentrate all your thoughts upon the work at hand. The sun\'s rays do not burn until brought to a focus.', author: 'Alexander Graham Bell' },
                { text: 'The successful warrior is the average man, with laser-like focus.', author: 'Bruce Lee' },
                { text: 'It is during our darkest moments that we must focus to see the light.', author: 'Aristotle' },
                { text: 'Where focus goes, energy flows.', author: 'Tony Robbins' },
                { text: 'Lack of direction, not lack of time, is the problem. We all have twenty-four hour days.', author: 'Zig Ziglar' },
                { text: 'People think focus means saying yes to the thing you\'ve got to focus on. It means saying no to the hundred other good ideas.', author: 'Steve Jobs' },
                { text: 'The key to success is to focus our conscious mind on things we desire, not things we fear.', author: 'Brian Tracy' },
                { text: 'You don\'t get results by focusing on results. You get results by focusing on the actions that produce results.', author: 'Mike Hawkins' },
                { text: 'Always remember, your focus determines your reality.', author: 'George Lucas' },
                { text: 'Do not dwell in the past, do not dream of the future, concentrate the mind on the present moment.', author: 'Buddha' },
            ]
        },
        {
            name: 'Growth',
            quotes: [
                { text: 'The only way to grow is to challenge yourself beyond your current ability.', author: 'Unknown' },
                { text: 'Be not afraid of growing slowly, be afraid only of standing still.', author: 'Chinese Proverb' },
                { text: 'Growth is painful. Change is painful. But nothing is as painful as staying stuck somewhere you don\'t belong.', author: 'Mandy Hale' },
                { text: 'The capacity to learn is a gift; the ability to learn is a skill; the willingness to learn is a choice.', author: 'Brian Herbert' },
                { text: 'Live as if you were to die tomorrow. Learn as if you were to live forever.', author: 'Mahatma Gandhi' },
                { text: 'What we know matters but who we are matters more.', author: 'Brene Brown' },
                { text: 'There is nothing noble in being superior to your fellow man; true nobility is being superior to your former self.', author: 'Ernest Hemingway' },
                { text: 'The beautiful thing about learning is that nobody can take it away from you.', author: 'B.B. King' },
                { text: 'We cannot become what we want by remaining what we are.', author: 'Max DePree' },
                { text: 'Education is not the filling of a pail, but the lighting of a fire.', author: 'William Butler Yeats' },
            ]
        },
        {
            name: 'Time',
            quotes: [
                { text: 'Time is what we want most, but what we use worst.', author: 'William Penn' },
                { text: 'The two most powerful warriors are patience and time.', author: 'Leo Tolstoy' },
                { text: 'Lost time is never found again.', author: 'Benjamin Franklin' },
                { text: 'Time you enjoy wasting is not wasted time.', author: 'Marthe Troly-Curtin' },
                { text: 'The bad news is time flies. The good news is you\'re the pilot.', author: 'Michael Altshuler' },
                { text: 'Don\'t watch the clock; do what it does. Keep going.', author: 'Sam Levenson' },
                { text: 'Time is the most valuable thing a man can spend.', author: 'Theophrastus' },
                { text: 'Yesterday is gone. Tomorrow has not yet come. We have only today. Let us begin.', author: 'Mother Teresa' },
                { text: 'The key is in not spending time, but in investing it.', author: 'Stephen Covey' },
                { text: 'Better three hours too soon than a minute too late.', author: 'William Shakespeare' },
            ]
        },
        {
            name: 'Simplicity',
            quotes: [
                { text: 'Simplicity is the ultimate sophistication.', author: 'Leonardo da Vinci' },
                { text: 'Life is really simple, but we insist on making it complicated.', author: 'Confucius' },
                { text: 'The greatest ideas are the simplest.', author: 'William Golding' },
                { text: 'Perfection is achieved, not when there is nothing more to add, but when there is nothing left to take away.', author: 'Antoine de Saint-Exupery' },
                { text: 'Simplicity is the keynote of all true elegance.', author: 'Coco Chanel' },
                { text: 'Our life is frittered away by detail. Simplify, simplify.', author: 'Henry David Thoreau' },
                { text: 'Any intelligent fool can make things bigger and more complex. It takes a touch of genius and a lot of courage to move in the opposite direction.', author: 'E.F. Schumacher' },
                { text: 'Nature is pleased with simplicity.', author: 'Isaac Newton' },
                { text: 'The art of being wise is the art of knowing what to overlook.', author: 'William James' },
                { text: 'Have nothing in your houses that you do not know to be useful or believe to be beautiful.', author: 'William Morris' },
            ]
        },
        {
            name: 'Action',
            quotes: [
                { text: 'The best time to plant a tree was 20 years ago. The second best time is now.', author: 'Chinese Proverb' },
                { text: 'Well done is better than well said.', author: 'Benjamin Franklin' },
                { text: 'An ounce of action is worth a ton of theory.', author: 'Ralph Waldo Emerson' },
                { text: 'Do what you can, with what you have, where you are.', author: 'Theodore Roosevelt' },
                { text: 'The secret of getting ahead is getting started.', author: 'Mark Twain' },
                { text: 'You miss 100% of the shots you don\'t take.', author: 'Wayne Gretzky' },
                { text: 'Action is the foundational key to all success.', author: 'Pablo Picasso' },
                { text: 'In any moment of decision, the best thing you can do is the right thing. The worst thing you can do is nothing.', author: 'Theodore Roosevelt' },
                { text: 'Knowing is not enough; we must apply. Willing is not enough; we must do.', author: 'Johann Wolfgang von Goethe' },
                { text: 'Vision without action is merely a dream. Action without vision just passes the time. Vision with action can change the world.', author: 'Joel A. Barker' },
            ]
        },
        {
            name: 'Resilience',
            quotes: [
                { text: 'The oak fought the wind and was broken, the willow bent when it must and survived.', author: 'Robert Jordan' },
                { text: 'Rock bottom became the solid foundation on which I rebuilt my life.', author: 'J.K. Rowling' },
                { text: 'Out of your vulnerabilities will come your strength.', author: 'Sigmund Freud' },
                { text: 'The human capacity for burden is like bamboo — far more flexible than you\'d ever believe at first glance.', author: 'Jodi Picoult' },
                { text: 'I can be changed by what happens to me. But I refuse to be reduced by it.', author: 'Maya Angelou' },
                { text: 'Do not judge me by my success, judge me by how many times I fell down and got back up again.', author: 'Nelson Mandela' },
                { text: 'When we are no longer able to change a situation, we are challenged to change ourselves.', author: 'Viktor Frankl' },
                { text: 'My barn having burned down, I can now see the moon.', author: 'Mizuta Masahide' },
                { text: 'Although the world is full of suffering, it is also full of the overcoming of it.', author: 'Helen Keller' },
                { text: 'The strongest people are not those who show strength in front of us but those who win battles we know nothing about.', author: 'Unknown' },
            ]
        },
    ],

    /**
     * Get all themes
     */
    getThemes() {
        return this.themes.map(t => t.name);
    },

    /**
     * Get all quotes, optionally filtered by theme and search query
     */
    search(query = '', theme = '') {
        let results = [];
        const lowerQuery = query.toLowerCase();

        for (const t of this.themes) {
            if (theme && t.name !== theme) continue;

            for (const q of t.quotes) {
                if (!lowerQuery ||
                    q.text.toLowerCase().includes(lowerQuery) ||
                    q.author.toLowerCase().includes(lowerQuery) ||
                    t.name.toLowerCase().includes(lowerQuery)) {
                    results.push({ ...q, theme: t.name });
                }
            }
        }

        return results;
    }
};
