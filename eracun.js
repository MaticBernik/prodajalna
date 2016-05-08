//Priprava knjižnic
var formidable = require("formidable");
var util = require('util');
var msg="";

if (!process.env.PORT)
  process.env.PORT = 8080;

// Priprava povezave na podatkovno bazo
var sqlite3 = require('sqlite3').verbose();
var pb = new sqlite3.Database('chinook.sl3');

// Priprava strežnika
var express = require('express');
var expressSession = require('express-session');
var streznik = express();
streznik.set('view engine', 'ejs');
streznik.use(express.static('public'));
streznik.use(
  expressSession({
    secret: '1234567890QWERTY', // Skrivni ključ za podpisovanje piškotkov
    saveUninitialized: true,    // Novo sejo shranimo
    resave: false,              // Ne zahtevamo ponovnega shranjevanja
    cookie: {
      maxAge: 3600000           // Seja poteče po 60min neaktivnosti
    }
  })
);

var razmerje_usd_eur = 0.877039116;

function davcnaStopnja(izvajalec, zanr) {
  switch (izvajalec) {
    case "Queen": case "Led Zepplin": case "Kiss":
      return 0;
    case "Justin Bieber":
      return 22;
    default:
      break;
  }
  switch (zanr) {
    case "Metal": case "Heavy Metal": case "Easy Listening":
      return 0;
    default:
      return 9.5;
  }
}

// Prikaz seznama pesmi na strani
streznik.get('/', function(zahteva, odgovor) {
  if(!zahteva.session.stranka){
    odgovor.redirect("/prijava");
  }else{
    pb.all("SELECT Track.TrackId AS id, Track.Name AS pesem, \
            Artist.Name AS izvajalec, Track.UnitPrice * " +
            razmerje_usd_eur + " AS cena, \
            COUNT(InvoiceLine.InvoiceId) AS steviloProdaj, \
            Genre.Name AS zanr \
            FROM Track, Album, Artist, InvoiceLine, Genre \
            WHERE Track.AlbumId = Album.AlbumId AND \
            Artist.ArtistId = Album.ArtistId AND \
            InvoiceLine.TrackId = Track.TrackId AND \
            Track.GenreId = Genre.GenreId \
            GROUP BY Track.TrackId \
            ORDER BY steviloProdaj DESC, pesem ASC \
            LIMIT 100", function(napaka, vrstice) {
      if (napaka)
        odgovor.sendStatus(500);
      else {
          for (var i=0; i<vrstice.length; i++)
            vrstice[i].stopnja = davcnaStopnja(vrstice[i].izvajalec, vrstice[i].zanr);
          odgovor.render('seznam', {seznamPesmi: vrstice});
        }
    })
  }
})

// Dodajanje oz. brisanje pesmi iz košarice
streznik.get('/kosarica/:idPesmi', function(zahteva, odgovor) {
  var idPesmi = parseInt(zahteva.params.idPesmi);
  if (!zahteva.session.kosarica)
    zahteva.session.kosarica = [];
  if (zahteva.session.kosarica.indexOf(idPesmi) > -1) {
    zahteva.session.kosarica.splice(zahteva.session.kosarica.indexOf(idPesmi), 1);
  } else {
    zahteva.session.kosarica.push(idPesmi);
  }
  
  odgovor.send(zahteva.session.kosarica);
});

// Vrni podrobnosti pesmi v košarici iz podatkovne baze
var pesmiIzKosarice = function(zahteva, callback) {
  if (!zahteva.session.kosarica || Object.keys(zahteva.session.kosarica).length == 0) {
    callback([]);
  } else {
    pb.all("SELECT Track.TrackId AS stevilkaArtikla, 1 AS kolicina, \
    Track.Name || ' (' || Artist.Name || ')' AS opisArtikla, \
    Track.UnitPrice * " + razmerje_usd_eur + " AS cena, 0 AS popust, \
    Genre.Name AS zanr \
    FROM Track, Album, Artist, Genre \
    WHERE Track.AlbumId = Album.AlbumId AND \
    Artist.ArtistId = Album.ArtistId AND \
    Track.GenreId = Genre.GenreId AND \
    Track.TrackId IN (" + zahteva.session.kosarica.join(",") + ")",
    function(napaka, vrstice) {
      if (napaka) {
        callback(false);
      } else {
        for (var i=0; i<vrstice.length; i++) {
          vrstice[i].stopnja = davcnaStopnja((vrstice[i].opisArtikla.split(' (')[1]).split(')')[0], vrstice[i].zanr);
        }
        callback(vrstice);
      }
    })
  }
}

streznik.get('/kosarica', function(zahteva, odgovor) {
  pesmiIzKosarice(zahteva, function(pesmi) {
    if (!pesmi)
      odgovor.sendStatus(500);
    else
      odgovor.send(pesmi);
  });
})

// Vrni podrobnosti pesmi na računu
var pesmiIzRacuna = function(racunId, callback) {
    pb.all("SELECT Track.TrackId AS stevilkaArtikla, 1 AS kolicina, \
    Track.Name || ' (' || Artist.Name || ')' AS opisArtikla, \
    Track.UnitPrice * " + razmerje_usd_eur + " AS cena, 0 AS popust, \
    Genre.Name AS zanr \
    FROM Track, Album, Artist, Genre \
    WHERE Track.AlbumId = Album.AlbumId AND \
    Artist.ArtistId = Album.ArtistId AND \
    Track.GenreId = Genre.GenreId AND \
    Track.TrackId IN (SELECT InvoiceLine.TrackId FROM InvoiceLine, Invoice \
    WHERE InvoiceLine.InvoiceId = Invoice.InvoiceId AND Invoice.InvoiceId = " + racunId + ")",
    function(napaka, vrstice) {
      if (napaka) {
        callback(false);
      } else {
        for (var i=0; i<vrstice.length; i++) {
          vrstice[i].stopnja = davcnaStopnja((vrstice[i].opisArtikla.split(' (')[1]).split(')')[0], vrstice[i].zanr);
        }
        callback(vrstice);
      }
    })
}

// Vrni podrobnosti o stranki iz računa
var strankaIzRacuna = function(racunId, callback) {
    pb.all("SELECT Customer.* FROM Customer, Invoice \
            WHERE Customer.CustomerId = Invoice.CustomerId AND Invoice.InvoiceId = " + racunId,
    function(napaka, vrstice) {
      console.log(vrstice);
      callback(vrstice);
    })
}

var postavkeNaRacunuIzBaz;
var strankaIzRacunaIzBaze;
var cakaj=0;
// Izpis računa v HTML predstavitvi na podlagi podatkov iz baze
streznik.post('/izpisiRacunBaza', function(zahteva, odgovor) {
  var form = new formidable.IncomingForm();
  var racunId;
  form.parse(zahteva, function (napaka1, polja, datoteke) {
    racunId=polja.seznamRacunov;
    //zahteva.session.kosarica=[];
    var pridobiPodatke = function (racunId,callback){
      strankaIzRacuna(racunId,function(stranka){
        strankaIzRacunaIzBaze=stranka;
        cakaj++;
        if(cakaj>=2){
          callback();
        }
      });  
      pesmiIzRacuna(racunId,function(lines){
        postavkeNaRacunuIzBaze=lines;
        console.log("postavkeNaRacunuIzBaze--->"+postavkeNaRacunuIzBaze[0]);
        cakaj++;
        if(cakaj>=2){
          callback();
        }
      });
    } 
    
    var izpisiHTML = function(){
      console.log("PODATKI SO ZBRANI:");
      console.log(postavkeNaRacunuIzBaze[0].zanr);
      console.log(strankaIzRacunaIzBaze);
      
      odgovor.setHeader('content-type', 'text/xml');
      odgovor.render('eslog', {
      vizualiziraj: true,
      postavkeRacuna: postavkeNaRacunuIzBaze,
      NazivPartnerja1: strankaIzRacunaIzBaze[0].FirstName+" "+strankaIzRacunaIzBaze[0].LastName,
      NazivPartnerja2: strankaIzRacunaIzBaze[0].Company,
      Ulica1: strankaIzRacunaIzBaze[0].Address,
      Kraj: strankaIzRacunaIzBaze[0].City,
      NazivDrzave: strankaIzRacunaIzBaze[0].Country,
      PostnaStevilka: strankaIzRacunaIzBaze[0].PostalCode,
      StevilkaKomunikacijeTE: strankaIzRacunaIzBaze[0].Phone,
      StevilkaKomunikacijeFX: strankaIzRacunaIzBaze[0].Fax,
      ImeOsebe: strankaIzRacunaIzBaze[0].FirstName+" "+strankaIzRacunaIzBaze[0].LastName+" ("+strankaIzRacunaIzBaze[0].Email+")"
      })  
    }
    cakaj=0;
    pridobiPodatke(racunId,izpisiHTML);
    });
  })

var vrniStranko = function(strankaId,callback){
  pb.all("SELECT Customer.* FROM Customer \
            WHERE Customer.CustomerId = " + strankaId,
    function(napaka, vrstice) {
      console.log(vrstice);
      callback(vrstice);
    })
}

// Izpis računa v HTML predstavitvi ali izvorni XML obliki
streznik.get('/izpisiRacun/:oblika', function(zahteva, odgovor) {
  pesmiIzKosarice(zahteva, function(pesmi) {
    if(!zahteva.session.stranka){
      odgovor.redirect('/prijava');
    }
    
    vrniStranko(zahteva.session.stranka,function(strankaData){
      if (!pesmi) {
      odgovor.sendStatus(500);
    } else if (pesmi.length == 0) {
      odgovor.send("<p>V košarici nimate nobene pesmi, \
        zato računa ni mogoče pripraviti!</p>");
    } else {
      odgovor.setHeader('content-type', 'text/xml');
      odgovor.render('eslog', {
        vizualiziraj: zahteva.params.oblika == 'html' ? true : false,
        postavkeRacuna: pesmi,
        NazivPartnerja1: strankaData[0].FirstName+" "+strankaData[0].LastName,
        NazivPartnerja2: strankaData[0].Company,
        Ulica1: strankaData[0].Address,
        Kraj: strankaData[0].City,
        NazivDrzave: strankaData[0].Country,
        PostnaStevilka: strankaData[0].PostalCode,
        StevilkaKomunikacijeTE: strankaData[0].Phone,
        StevilkaKomunikacijeFX: strankaData[0].Fax,
        ImeOsebe: strankaData[0].FirstName+" "+strankaData[0].LastName+" ("+strankaData[0].Email+")"
      })  
    }
    });
    
    
  })
})

// Privzeto izpiši račun v HTML obliki
streznik.get('/izpisiRacun', function(zahteva, odgovor) {
  odgovor.redirect('/izpisiRacun/html');
})

// Vrni stranke iz podatkovne baze
var vrniStranke = function(callback) {
  pb.all("SELECT * FROM Customer",
    function(napaka, vrstice) {
      callback(napaka, vrstice);
    }
  );
}

// Vrni račune iz podatkovne baze
var vrniRacune = function(callback) {
  pb.all("SELECT Customer.FirstName || ' ' || Customer.LastName || ' (' || Invoice.InvoiceId || ') - ' || date(Invoice.InvoiceDate) AS Naziv, \
          Invoice.InvoiceId \
          FROM Customer, Invoice \
          WHERE Customer.CustomerId = Invoice.CustomerId",
    function(napaka, vrstice) {
      callback(napaka, vrstice);
    }
  );
}

// Registracija novega uporabnika
streznik.post('/prijava', function(zahteva, odgovor) {
  var form = new formidable.IncomingForm();
  
  form.parse(zahteva, function (napaka1, polja, datoteke) {
    var napaka2 = false;
    try {
      var stmt = pb.prepare("\
        INSERT INTO Customer \
    	  (FirstName, LastName, Company, \
    	  Address, City, State, Country, PostalCode, \
    	  Phone, Fax, Email, SupportRepId) \
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
      //TODO: add fields and finalize
      stmt.run(polja.FirstName,polja.LastName,polja.Company,polja.Address,polja.City,polja.State,polja.Country,polja.PostalCode,polja.Phone,polja.Fax,polja.Email, 3); 
      stmt.finalize();
    } catch (err) {
      napaka2 = true;
      console.log(err.message);
    }
    if(napaka2){
      msg="Prišlo je do napake pri registraciji nove stranke. Prosim preverite vnešene podatke in poskusite znova.";
    }else{
      msg="Stranka je bila uspešno registrirana.";
    }  
    odgovor.redirect("/prijava");
    odgovor.end();
  });
})

// Prikaz strani za prijavo
streznik.get('/prijava', function(zahteva, odgovor) {
  vrniStranke(function(napaka1, stranke) {
      vrniRacune(function(napaka2, racuni) {
        odgovor.render('prijava', {sporocilo: msg, seznamStrank: stranke, seznamRacunov: racuni});  //msg --> ""
        msg="";
      }) 
    });
})

// Prikaz nakupovalne košarice za stranko
streznik.post('/stranka', function(zahteva, odgovor) {
  var form = new formidable.IncomingForm();
  
  form.parse(zahteva, function (napaka1, polja, datoteke) {
    zahteva.session.stranka=polja.seznamStrank;
    odgovor.redirect('/')
  });
})

// Odjava stranke
streznik.post('/odjava', function(zahteva, odgovor) {
    zahteva.session.destroy();
    odgovor.redirect('/prijava') 
})



streznik.listen(process.env.PORT, function() {
  console.log("Strežnik pognan!");
})
