FROM node:10.15.3
ADD package.json .
RUN npm install
ADD lib lib
CMD ["node", "lib/index.js"]
