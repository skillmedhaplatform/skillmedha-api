# Student API Use the Official Node.js 18.13.0 image as the base
FROM node:current-alpine3.22

#Set the Working directory inside the Containse
WORKDIR /usr/src/app

#Copy package.jsno and package-lock.json to the working directory
COPY package*.json ./

#install App dependencies
RUN npm install

#Copy the rest of the application cose to the working directory
COPY . .

#Expose a port for the applicationto listen on
EXPOSE 2001

#Start the Application
CMD ["node","--env-file=.env", "src/app.js"]